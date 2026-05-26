import React, { useState, useMemo, useEffect } from 'react';
import { Home, Minimize2, RotateCcw, Globe, PanelLeft, FileEdit } from 'lucide-react';
import { VscVscode } from 'react-icons/vsc';
import { useUIStore } from '../../store/useUIStore';
import Tooltip from '../UI/Tooltip';
import { useWorkspaceStore, isTabInterrupted } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { compressLogs } from '../../utils/compressLogs';
import SemanticIndexButton from './SemanticIndexButton';
import CopySessionWithChips from './CopySessionWithChips';
import DocsButton from './DocsButton';
import DictationHistoryButton from './DictationHistoryButton';
import ClaudeUsageButton from './ClaudeUsageButton';

const { ipcRenderer } = window.require('electron');

export default function ProjectToolbar() {
  const { showToast } = useUIStore();
  const { activeProjectId, openProjects, clearInterruptedState, setTabCommandType, createBrowserTab, setProjectView, getEffectiveTabId, getSidebarState, setSidebarOpen } = useWorkspaceStore();
  const { projects } = useProjectsStore();

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

  const handleOpenVSCode = () => {
    if (!activeProjectId) return;
    const workspace = openProjects.get(activeProjectId);
    const currentProject = projects[activeProjectId];
    const effectiveId = getEffectiveTabId();
    const currentTab = effectiveId && workspace ? workspace.tabs.get(effectiveId) : null;
    const cwd = currentTab?.cwd || currentProject?.path;
    if (!cwd) {
      showToast('Не удалось определить директорию проекта', 'error');
      return;
    }
    const { exec } = window.require('child_process');
    exec('code .', { cwd }, (err: Error | null) => {
      if (err) {
        showToast('Не удалось открыть VS Code (нужен `code` в PATH)', 'error');
      }
    });
  };

  // Trampoline to GT Editor via custom `gteditor://open` URL scheme. macOS
  // LaunchServices routes to the already-running GT Editor.app (or cold-launches
  // it), and the receiving renderer adds the folder to its directory list if
  // missing — see gt-editor/docs/knowledge/fact-goto-modal.md.
  const handleOpenGTEditor = () => {
    if (!activeProjectId) return;
    const workspace = openProjects.get(activeProjectId);
    const currentProject = projects[activeProjectId];
    const effectiveId = getEffectiveTabId();
    const currentTab = effectiveId && workspace ? workspace.tabs.get(effectiveId) : null;
    const cwd = currentTab?.cwd || currentProject?.path;
    if (!cwd) {
      showToast('Не удалось определить директорию проекта', 'error');
      return;
    }
    const { shell } = window.require('electron');
    shell.openExternal(`gteditor://open?folder=${encodeURIComponent(cwd)}`).catch((err: Error) => {
      showToast(`GT Editor: ${err.message}`, 'error');
    });
  };

  // Cmd+G — глобальный хоткей для «Открыть в GT Editor». Используем `e.code`
  // ('KeyG'), а не `e.key`, чтобы хоткей работал в кириллической раскладке
  // тоже (в кириллице `e.key === 'п'`, но `e.code === 'KeyG'` остаётся
  // физическим клавиатурным сигналом). Тот же паттерн, что для Cmd+T / Cmd+W
  // / Cmd+, в App.tsx — единая конвенция в проекте.
  // Гарды: игнорируем, если фокус в input/textarea/contenteditable (юзер
  // печатает букву G) и если Shift/Alt/Ctrl нажаты (Cmd+Shift+G — find prev
  // в браузерах, потенциальный конфликт).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      if (e.code !== 'KeyG') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const editable = target?.isContentEditable;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || editable) return;
      e.preventDefault();
      handleOpenGTEditor();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeProjectId, openProjects, projects]);

  const handleCompressLogs = async () => {
    if (isCompressing) return;

    setIsCompressing(true);
    try {
      // navigator.clipboard в production Electron-renderer falls back to
      // секурного контекста (file://) — readText/writeText тихо reject'ятся.
      // Electron clipboard module (main) работает безусловно. Тот же
      // anti-pattern см. в CLAUDE.md «Не используй navigator.clipboard в renderer».
      const { clipboard } = window.require('electron');
      const clipboardText = clipboard.readText();
      const result = compressLogs(clipboardText);

      if (result.success) {
        clipboard.writeText(result.compressed);
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
      {/* File Explorer Toggle (Cmd+B) — was inside TabBar before the layout migration */}
      <Tooltip content="Toggle file explorer">
      <button
        onClick={() => {
          if (!activeProjectId) return;
          const { sidebarOpen } = getSidebarState(activeProjectId);
          setSidebarOpen(activeProjectId, !sidebarOpen);
        }}
        className="h-full flex items-center px-3 text-[#666] hover:text-white hover:bg-[rgba(255,255,255,0.05)] transition-all duration-150"
      >
        <PanelLeft size={14} />
      </button>
      </Tooltip>

      {/* Home Button */}
      <Tooltip content="Project Home">
      <button
        onClick={() => activeProjectId && setProjectView(activeProjectId, isHomeActive ? 'terminal' : 'home')}
        style={buttonStyle(isHomeActive)}
        onMouseEnter={(e) => handleMouseEnter(e, isHomeActive)}
        onMouseLeave={(e) => handleMouseLeave(e, isHomeActive)}
      >
        <Home size={14} />
        <span>Home</span>
      </button>
      </Tooltip>

      {/* Compress Logs Button */}
      <Tooltip content="Сжать логи из буфера обмена">
      <button
        onClick={handleCompressLogs}
        style={buttonStyle(false)}
        onMouseEnter={(e) => handleMouseEnter(e, false)}
        onMouseLeave={(e) => handleMouseLeave(e, false)}
        disabled={isCompressing}
      >
        <Minimize2 size={14} className={isCompressing ? 'text-indigo-400 animate-glow-indigo' : ''} />
      </button>
      </Tooltip>

      {/* Browser Tab Button */}
      <Tooltip content="Open browser tab">
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
      >
        <Globe size={14} />
      </button>
      </Tooltip>

      {/* Open in VS Code Button */}
      <Tooltip content="Открыть проект в VS Code">
      <button
        onClick={handleOpenVSCode}
        style={buttonStyle(false)}
        onMouseEnter={(e) => handleMouseEnter(e, false)}
        onMouseLeave={(e) => handleMouseLeave(e, false)}
      >
        <VscVscode size={14} />
      </button>
      </Tooltip>

      {/* Open in GT Editor Button */}
      <Tooltip content="Открыть проект в GT Editor (⌘G)">
      <button
        onClick={handleOpenGTEditor}
        style={buttonStyle(false)}
        onMouseEnter={(e) => handleMouseEnter(e, false)}
        onMouseLeave={(e) => handleMouseLeave(e, false)}
      >
        <FileEdit size={14} />
      </button>
      </Tooltip>

      {/* Semantic Index Status */}
      <SemanticIndexButton
        onOpenSettings={() => {
          // App.tsx слушает settings:open и открывает SettingsModal на нужном табе.
          window.dispatchEvent(new CustomEvent('settings:open', { detail: { tab: 'colors' } }));
        }}
      />

      {/* Resume All Interrupted Sessions Button - only shows when there are interrupted tabs */}
      {interruptedTabs.length > 0 && (
        <Tooltip content={`Resume all ${interruptedTabs.length} interrupted session(s)`}>
        <button
          onClick={handleResumeAll}
          style={buttonStyle(false)}
          onMouseEnter={(e) => handleMouseEnter(e, false)}
          onMouseLeave={(e) => handleMouseLeave(e, false)}
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
        </Tooltip>
      )}

      {/* Flex spacer — pushes session-copy cluster to the right edge of the toolbar */}
      <div style={{ flex: 1 }} />

      {/* Claude usage chip — weekly utilization % from Anthropic OAuth usage API
          (same source as Blimp-Labs claude-usage-bar). Sits left of Dictation
          history; popover opens DOWN with full 5h/7d/extra-credits breakdown. */}
      <div className="flex items-center pr-2">
        <ClaudeUsageButton />
      </div>

      {/* Dictation history — last 100 transcripts captured via the bottom-bar mic.
          Sits left of Docs/Copy because it's not session-bound (lives across all
          projects) and the user reaches for it independently of the session-copy
          flow. Renders the same chip-shaped dropdown style as CopySessionButton. */}
      <div className="flex items-center pr-2">
        <DictationHistoryButton />
      </div>

      {/* Docs popover trigger — opens ActionsPanel (Update Docs / Update API → Haiku
          pipeline). Pair-aligned with CopySessionWithChips popover: both anchor to
          their trigger's bottom-right edge so the two popovers share the same
          downward-opening direction. */}
      <div className="flex items-center pr-2">
        <DocsButton />
      </div>

      {/* CopySessionButton + chip-row — moved here from InfoPanel. Renders nothing
          when there's no active Claude/Gemini session, so the toolbar collapses
          gracefully on Home / generic tabs. */}
      <div className="flex items-center pr-3">
        <CopySessionWithChips />
      </div>
    </div>
  );
}
