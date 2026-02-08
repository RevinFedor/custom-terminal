import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Home, Minimize2, Play, ChevronDown, RotateCcw, Globe } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore, isTabInterrupted } from '../../store/useWorkspaceStore';
import { compressLogs } from '../../utils/compressLogs';

const { ipcRenderer } = window.require('electron');

export default function ProjectToolbar() {
  const { currentView, setCurrentView, showToast } = useUIStore();
  const { activeProjectId, getActiveTab, openProjects, clearInterruptedState, setTabCommandType, createBrowserTab } = useWorkspaceStore();

  // Get active tab ID to trigger updates when switching tabs
  const activeTabId = activeProjectId
    ? openProjects.get(activeProjectId)?.activeTabId
    : null;
  const [isCompressing, setIsCompressing] = useState(false);
  const [scripts, setScripts] = useState<string[]>([]);
  const [showScriptsDropdown, setShowScriptsDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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

  // Track current terminal directory for scripts
  const [terminalCwd, setTerminalCwd] = useState<string | null>(null);

  // Get current directory from active terminal
  useEffect(() => {
    const fetchCwd = async () => {
      if (!activeProjectId) {
        setTerminalCwd(null);
        return;
      }

      const activeTab = getActiveTab(activeProjectId);
      if (!activeTab) {
        setTerminalCwd(null);
        return;
      }

      try {
        // Get actual cwd from terminal (may differ from tab.cwd after `cd`)
        const cwd = await ipcRenderer.invoke('terminal:getCwd', activeTab.id);
        console.log('[ProjectToolbar] Got terminal cwd:', cwd);
        setTerminalCwd(cwd || activeTab.cwd);
      } catch (err) {
        console.log('[ProjectToolbar] Could not get cwd, using tab.cwd:', activeTab.cwd);
        setTerminalCwd(activeTab.cwd);
      }
    };

    fetchCwd();
  }, [activeProjectId, activeTabId, getActiveTab]);

  // Fetch scripts from package.json in current directory
  useEffect(() => {
    const fetchScripts = async () => {
      console.log('[ProjectToolbar] fetchScripts, terminalCwd:', terminalCwd);
      if (!terminalCwd) {
        setScripts([]);
        return;
      }

      try {
        const packageJsonPath = `${terminalCwd}/package.json`;
        console.log('[ProjectToolbar] Reading package.json from:', packageJsonPath);
        const result = await ipcRenderer.invoke('file:read', packageJsonPath);
        console.log('[ProjectToolbar] file:read result:', result);
        if (result?.success && result.content) {
          const pkg = JSON.parse(result.content);
          console.log('[ProjectToolbar] Parsed package.json, scripts:', pkg.scripts ? Object.keys(pkg.scripts) : 'none');
          if (pkg.scripts) {
            // Filter out scripts starting with _ (hidden/internal scripts)
            const visibleScripts = Object.keys(pkg.scripts).filter(name => !name.startsWith('_'));
            console.log('[ProjectToolbar] Visible scripts (excluding _):', visibleScripts);
            setScripts(visibleScripts);
          } else {
            setScripts([]);
          }
        } else {
          setScripts([]);
        }
      } catch (err) {
        // Silently fail if package.json doesn't exist in current dir
        console.log('[ProjectToolbar] No package.json in:', terminalCwd);
        setScripts([]);
      }
    };

    fetchScripts();
  }, [terminalCwd]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowScriptsDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Refresh cwd and scripts when opening dropdown
  const handleOpenScriptsDropdown = async () => {
    if (showScriptsDropdown) {
      setShowScriptsDropdown(false);
      return;
    }

    // Refresh cwd before showing dropdown
    if (activeProjectId) {
      const activeTab = getActiveTab(activeProjectId);
      if (activeTab) {
        try {
          const cwd = await ipcRenderer.invoke('terminal:getCwd', activeTab.id);
          console.log('[ProjectToolbar] Refreshed cwd on dropdown open:', cwd);
          if (cwd && cwd !== terminalCwd) {
            setTerminalCwd(cwd);
          }
        } catch (err) {
          console.log('[ProjectToolbar] Could not refresh cwd');
        }
      }
    }

    setShowScriptsDropdown(true);
  };

  const handleRunScript = (scriptName: string) => {
    console.log('[ProjectToolbar] handleRunScript called:', scriptName);
    if (!activeProjectId) {
      console.log('[ProjectToolbar] No activeProjectId');
      return;
    }

    const activeTab = getActiveTab(activeProjectId);
    console.log('[ProjectToolbar] activeTab:', activeTab?.id);
    if (activeTab) {
      const command = `npm run ${scriptName}\r`;
      console.log('[ProjectToolbar] Sending to terminal:', command);
      ipcRenderer.send('terminal:input', activeTab.id, command);
      setShowScriptsDropdown(false);
      setCurrentView('terminal');
    } else {
      showToast('Нет активной вкладки терминала', 'warning');
    }
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
    transition: 'all 0.15s ease',
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
        onClick={() => setCurrentView(isHomeActive ? 'terminal' : 'home')}
        style={buttonStyle(isHomeActive)}
        onMouseEnter={(e) => handleMouseEnter(e, isHomeActive)}
        onMouseLeave={(e) => handleMouseLeave(e, isHomeActive)}
        title="Project Home"
      >
        <Home size={14} />
        <span>Home</span>
      </button>

      {/* Scripts Dropdown Button */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={handleOpenScriptsDropdown}
          style={buttonStyle(showScriptsDropdown)}
          onMouseEnter={(e) => handleMouseEnter(e, showScriptsDropdown)}
          onMouseLeave={(e) => handleMouseLeave(e, showScriptsDropdown)}
          title="npm run scripts"
        >
          <Play size={14} />
          <ChevronDown size={10} className={`ml-[-2px] transition-transform duration-200 ${showScriptsDropdown ? 'rotate-180' : ''}`} />
        </button>

        {showScriptsDropdown && (
          <div className="absolute top-[30px] left-0 bg-[#1e1e1e] border border-[#333] shadow-2xl z-[100] py-1 min-w-[180px] max-h-[400px] overflow-y-auto">
            {scripts.length > 0 ? (
              scripts.map((script) => (
                <div
                  key={script}
                  className="px-3 py-1.5 text-[12px] text-[#aaa] hover:text-white hover:bg-white/10 cursor-pointer transition-colors flex items-center gap-2 group"
                  onClick={() => handleRunScript(script)}
                >
                  <div className="w-1 h-1 rounded-full bg-[#555] group-hover:bg-accent transition-colors" />
                  <span className="truncate flex-1">{script}</span>
                </div>
              ))
            ) : (
              <div className="px-3 py-2 text-[11px] text-[#666] italic">
                Scripts not found
              </div>
            )}
          </div>
        )}
      </div>

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
            setCurrentView('terminal');
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
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            padding: '0 12px',
            height: '100%',
            fontSize: '13px',
            color: '#fff',
            backgroundColor: 'rgba(59, 130, 246, 0.3)',
            borderTop: '2px solid #3b82f6',
            borderBottom: 'none',
            borderLeft: 'none',
            borderRight: 'none',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            outline: 'none',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.5)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.3)';
          }}
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
