import React, { useState, useEffect } from 'react';
import { useUIStore } from '../../../store/useUIStore';

const { ipcRenderer } = window.require('electron');

interface Session {
  id: number;
  session_key: string;
  tool_type: 'gemini' | 'claude';
  updated_at: number;
}

interface SessionsPanelProps {
  projectPath: string;
  activeTabId: string | null;
}

export default function SessionsPanel({ projectPath, activeTabId }: SessionsPanelProps) {
  const { showToast, showSessionModal } = useUIStore();
  const [geminiSessions, setGeminiSessions] = useState<Session[]>([]);
  const [claudeSessions, setClaudeSessions] = useState<Session[]>([]);
  const [selectedGemini, setSelectedGemini] = useState<string | null>(null);
  const [selectedClaude, setSelectedClaude] = useState<string | null>(null);

  useEffect(() => {
    loadSessions();
  }, [projectPath]);

  const loadSessions = async () => {
    try {
      const result = await ipcRenderer.invoke('session:list', {
        dirPath: projectPath,
        toolType: null
      });

      if (result.success && result.data) {
        setGeminiSessions(result.data.filter((s: Session) => s.tool_type === 'gemini'));
        setClaudeSessions(result.data.filter((s: Session) => s.tool_type === 'claude'));
      }
    } catch (err) {
      console.error('[Sessions] Error loading:', err);
    }
  };

  const getTimeAgo = (timestamp: number) => {
    const seconds = Math.floor((Date.now() - timestamp * 1000) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  };

  const deleteSession = async (id: number) => {
    if (!confirm('Delete this session?')) return;

    const result = await ipcRenderer.invoke('session:delete', id);
    if (result.success) {
      showToast('Session deleted', 'success');
      loadSessions();
    } else {
      showToast('Failed to delete', 'error');
    }
  };

  // Gemini Export
  const exportGeminiSession = async () => {
    if (!activeTabId) {
      showToast('Please open a terminal tab first', 'error');
      return;
    }

    const sessionKey = await showSessionModal(
      'Export Gemini Session',
      'Checkpoint Name',
      'session-' + Date.now(),
      'This will run "/chat save <name>" in your terminal'
    );

    if (!sessionKey) return;

    showToast('Saving checkpoint in Gemini...', 'info');
    ipcRenderer.send('terminal:executeCommand', activeTabId, `/chat save ${sessionKey}`);

    // Wait for Gemini to confirm
    await new Promise(resolve => setTimeout(resolve, 3000));

    const result = await ipcRenderer.invoke('session:export-gemini', {
      dirPath: projectPath,
      sessionKey
    });

    if (result.success) {
      showToast(result.message, 'success');
      loadSessions();
    } else {
      showToast('Export failed: ' + result.message, 'error');
    }
  };

  // Gemini Import
  const importGeminiSession = async () => {
    if (!activeTabId) {
      showToast('Please create a tab first', 'error');
      return;
    }

    if (!selectedGemini) {
      showToast('Please select a session from the list', 'error');
      return;
    }

    showToast('Restoring session...', 'info');

    const result = await ipcRenderer.invoke('session:import-gemini', {
      dirPath: projectPath,
      sessionKey: selectedGemini,
      tabId: activeTabId
    });

    if (result.success) {
      showToast(result.message, 'success');

      // Auto-resume
      showToast('Starting Gemini CLI...', 'info');
      ipcRenderer.send('terminal:executeCommand', activeTabId, 'gemini');
      await new Promise(resolve => setTimeout(resolve, 2000));
      ipcRenderer.send('terminal:executeCommand', activeTabId, `/chat resume ${selectedGemini}`);
    } else {
      showToast('Import failed: ' + result.message, 'error');
    }
  };

  // Claude Export
  const exportClaudeSession = async () => {
    const sessionKey = await showSessionModal(
      'Export Claude Session',
      'Session UUID (optional)',
      '',
      'Leave empty to auto-detect latest session'
    );

    const result = await ipcRenderer.invoke('session:export-claude', {
      dirPath: projectPath,
      sessionKey: sessionKey || ''
    });

    if (result.success) {
      showToast(result.message, 'success');
      loadSessions();
    } else {
      showToast('Export failed: ' + result.message, 'error');
    }
  };

  // Claude Import
  const importClaudeSession = async () => {
    if (!selectedClaude) {
      showToast('Please select a session from the list', 'error');
      return;
    }

    const result = await ipcRenderer.invoke('session:import-claude', {
      dirPath: projectPath,
      sessionKey: selectedClaude
    });

    if (result.success) {
      showToast(result.message, 'success');
      if (result.commands?.[0]) {
        showToast(`Run: ${result.commands[0]}`, 'info');
      }
    } else {
      showToast('Import failed: ' + result.message, 'error');
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 bg-[#333] text-[11px] uppercase text-[#aaa] shrink-0">
        Session Persistence
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {/* Gemini Section */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-[#4da6ff]">
              Gemini <span className="text-[10px] text-[#666]">({geminiSessions.length})</span>
            </span>
            <div className="flex gap-1">
              <button
                className="text-[9px] px-2 py-1 bg-[#333] border border-[#444] rounded hover:bg-[#444] text-[#aaa]"
                onClick={exportGeminiSession}
              >
                Export
              </button>
              <button
                className="text-[9px] px-2 py-1 bg-[#333] border border-[#444] rounded hover:bg-[#444] text-[#aaa]"
                onClick={importGeminiSession}
              >
                Import
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            {geminiSessions.length === 0 ? (
              <div className="text-[10px] text-[#555] italic">No saved sessions</div>
            ) : (
              geminiSessions.map((session) => (
                <div
                  key={session.id}
                  className={`flex items-center gap-2 p-2 bg-[#2a2a2a] hover:bg-[#333] rounded cursor-pointer border transition-colors ${
                    selectedGemini === session.session_key
                      ? 'border-accent'
                      : 'border-transparent hover:border-[#444]'
                  }`}
                  onClick={() => setSelectedGemini(session.session_key)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white truncate">{session.session_key}</div>
                    <div className="text-[10px] text-[#666]">{getTimeAgo(session.updated_at)}</div>
                  </div>
                  <button
                    className="text-[#888] hover:text-red-500 text-xs"
                    onClick={(e) => { e.stopPropagation(); deleteSession(session.id); }}
                  >
                    🗑️
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Claude Section */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-[#ff9f43]">
              Claude <span className="text-[10px] text-[#666]">({claudeSessions.length})</span>
            </span>
            <div className="flex gap-1">
              <button
                className="text-[9px] px-2 py-1 bg-[#333] border border-[#444] rounded hover:bg-[#444] text-[#aaa]"
                onClick={exportClaudeSession}
              >
                Export
              </button>
              <button
                className="text-[9px] px-2 py-1 bg-[#333] border border-[#444] rounded hover:bg-[#444] text-[#aaa]"
                onClick={importClaudeSession}
              >
                Import
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            {claudeSessions.length === 0 ? (
              <div className="text-[10px] text-[#555] italic">No saved sessions</div>
            ) : (
              claudeSessions.map((session) => (
                <div
                  key={session.id}
                  className={`flex items-center gap-2 p-2 bg-[#2a2a2a] hover:bg-[#333] rounded cursor-pointer border transition-colors ${
                    selectedClaude === session.session_key
                      ? 'border-accent'
                      : 'border-transparent hover:border-[#444]'
                  }`}
                  onClick={() => setSelectedClaude(session.session_key)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white truncate">{session.session_key}</div>
                    <div className="text-[10px] text-[#666]">{getTimeAgo(session.updated_at)}</div>
                  </div>
                  <button
                    className="text-[#888] hover:text-red-500 text-xs"
                    onClick={(e) => { e.stopPropagation(); deleteSession(session.id); }}
                  >
                    🗑️
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
