import React, { useState, useMemo } from 'react';
import { Home, Minimize2, RotateCcw, Globe } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore, isTabInterrupted } from '../../store/useWorkspaceStore';
import { compressLogs } from '../../utils/compressLogs';

const { ipcRenderer } = window.require('electron');

export default function ProjectToolbar() {
  const { showToast } = useUIStore();
  const { activeProjectId, openProjects, clearInterruptedState, setTabCommandType, createBrowserTab, setProjectView } = useWorkspaceStore();

  const [isCompressing, setIsCompressing] = useState(false);

  const currentView = activeProjectId ? openProjects.get(activeProjectId)?.currentView || 'terminal' : 'terminal';
  const isHomeActive = currentView === 'home';

  // Get interrupted tabs for CURRENT project only
  const interruptedTabs = useMemo(() => {
    if (!activeProjectId) return [];

    const workspace = openProjects.get(activeProjectId);
    if (!workspace) return [];

    const tabs: Array<{
      id: string;
      claudeSessionId?: string;
      geminiSessionId?: string;
    }> = [];

    workspace.tabs.forEach((tab) => {
      if (isTabInterrupted(tab)) {
        tabs.push({
          id: tab.id,
          claudeSessionId: tab.claudeSessionId,
          geminiSessionId: tab.geminiSessionId,
        });
      }
    });

    return tabs;
  }, [openProjects, activeProjectId]);

  // Resume all interrupted sessions
  const handleResumeAll = () => {
    if (interruptedTabs.length === 0) return;

    interruptedTabs.forEach((tab) => {
      // Clear interrupted state
      clearInterruptedState(tab.id);

      // Send resume command based on session type
      if (tab.claudeSessionId) {
        setTabCommandType(tab.id, 'claude');
        const cmd = `claude --dangerously-skip-permissions --resume ${tab.claudeSessionId}\r`;
        ipcRenderer.send('terminal:input', tab.id, cmd);
        ipcRenderer.send('terminal:force-command-started', tab.id);
      } else if (tab.geminiSessionId) {
        setTabCommandType(tab.id, 'gemini');
        const cmd = `gemini -s ${tab.geminiSessionId}\r`;
        ipcRenderer.send('terminal:input', tab.id, cmd);
        ipcRenderer.send('terminal:force-command-started', tab.id);
      }
    });

    showToast(`Resumed ${interruptedTabs.length} session(s)`, 'success');
  };

  const handleCompressLogs = async () => {
    if (isCompressing) return;

    setIsCompressing(true);
    try {
      const clipboardText = await navigator.clipboard.readText();
      const result = compressLogs(clipboardText);

      if (result.success) {
        await navigator.clipboard.writeText(result.compressed);
        showToast(result.message, 'success');
      } else {
        showToast(result.message, 'warning');
      }
    } catch (err) {
      showToast('Ошибка доступа к буферу обмена', 'error');
    } finally {
      setIsCompressing(false);
    }
  };

  const buttonStyle = (isActive: boolean) => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    padding: '0 12px',
    height: '100%',
    fontSize: '13px',
    color: isActive ? '#fff' : '#888',
    backgroundColor: isActive ? 'rgba(255,255,255,0.05)' : 'transparent',
    borderTop: isActive ? '2px solid rgba(255,255,255,0.7)' : '2px solid transparent',
    borderBottom: 'none',
    borderLeft: 'none',
    borderRight: 'none',
    cursor: 'pointer',
    outline: 'none',
  });

  const handleMouseEnter = (e: React.MouseEvent<HTMLButtonElement>, isActive: boolean) => {
    if (!isActive) {
      e.currentTarget.style.color = '#fff';
      e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)';
    }
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLButtonElement>, isActive: boolean) => {
    if (!isActive) {
      e.currentTarget.style.color = '#888';
      e.currentTarget.style.backgroundColor = 'transparent';
    }
  };

  return (
    <div
      className="h-[30px] w-full bg-panel flex items-stretch"
    >
      {/* Home Button */}
      <button
        onClick={() => activeProjectId && setProjectView(activeProjectId, isHomeActive ? 'terminal' : 'home')}
        style={buttonStyle(isHomeActive)}
        onMouseEnter={(e) => handleMouseEnter(e, isHomeActive)}
        onMouseLeave={(e) => handleMouseLeave(e, isHomeActive)}
        title="Project Home"
      >
        <Home size={14} />
        <span>Home</span>
      </button>

      {/* Compress Logs Button */}
      <button
        onClick={handleCompressLogs}
        style={buttonStyle(false)}
        onMouseEnter={(e) => handleMouseEnter(e, false)}
        onMouseLeave={(e) => handleMouseLeave(e, false)}
        title="Сжать логи из буфера обмена"
        disabled={isCompressing}
      >
        <Minimize2 size={14} className={isCompressing ? 'animate-pulse' : ''} />
      </button>

      {/* Browser Tab Button */}
      <button
        onClick={() => {
          if (activeProjectId) {
            createBrowserTab(activeProjectId);
            setProjectView(activeProjectId, 'terminal');
          }
        }}
        style={buttonStyle(false)}
        onMouseEnter={(e) => handleMouseEnter(e, false)}
        onMouseLeave={(e) => handleMouseLeave(e, false)}
        title="Open browser tab"
      >
        <Globe size={14} />
      </button>

      {/* Resume All Interrupted Sessions Button - only shows when there are interrupted tabs */}
      {interruptedTabs.length > 0 && (
        <button
          onClick={handleResumeAll}
          style={buttonStyle(false)}
          onMouseEnter={(e) => handleMouseEnter(e, false)}
          onMouseLeave={(e) => handleMouseLeave(e, false)}
          title={`Resume all ${interruptedTabs.length} interrupted session(s)`}
        >
          <RotateCcw size={14} />
          <span
            style={{
              backgroundColor: 'rgba(59, 130, 246, 0.4)',
              padding: '0 6px',
              borderRadius: '4px',
              fontSize: '10px',
              fontWeight: 500,
            }}
          >
            {interruptedTabs.length}
          </span>
        </button>
      )}
    </div>
  );
}
