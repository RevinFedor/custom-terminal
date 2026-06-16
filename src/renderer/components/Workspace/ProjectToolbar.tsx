import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Home, Minimize2, RotateCcw, Globe, PanelLeft, FileEdit, RefreshCw, Sparkles } from 'lucide-react';
import { VscVscode } from 'react-icons/vsc';
import { useUIStore } from '../../store/useUIStore';
import Tooltip from '../UI/Tooltip';
import { useWorkspaceStore, isTabInterrupted } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { compressLogs } from '../../utils/compressLogs';
import { markPendingResume } from '../../utils/pendingResume';
import SemanticIndexButton from './SemanticIndexButton';
import CopySessionWithChips from './CopySessionWithChips';
import DocsButton from './DocsButton';
import ClaudeUsageButton from './ClaudeUsageButton';
import { buildCodexRunPayload } from '../../utils/codexLaunch';
import { useTimelineSummaryStore, type TimelineSummaryTool } from '../../store/useTimelineSummaryStore';

const { ipcRenderer } = window.require('electron');

export default function ProjectToolbar() {
  const showToast = useUIStore((state) => state.showToast);
  const activeProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const currentView = useWorkspaceStore((state) => {
    const projectId = state.activeProjectId;
    if (!projectId) return 'terminal';
    return state.openProjects.get(projectId)?.currentView || 'terminal';
  });
  const interruptedTabsKey = useWorkspaceStore((state) => {
    const projectId = state.activeProjectId;
    if (!projectId) return '';
    const workspace = state.openProjects.get(projectId);
    if (!workspace) return '';

    const parts: string[] = [];
    workspace.tabs.forEach((tab) => {
      if (isTabInterrupted(tab)) {
        parts.push(`${tab.id}:${tab.claudeSessionId || ''}:${tab.geminiSessionId || ''}:${tab.codexSessionId || ''}`);
      }
    });
    return parts.join('|');
  });
  const clearInterruptedState = useWorkspaceStore((state) => state.clearInterruptedState);
  const setTabCommandType = useWorkspaceStore((state) => state.setTabCommandType);
  const createBrowserTab = useWorkspaceStore((state) => state.createBrowserTab);
  const setProjectView = useWorkspaceStore((state) => state.setProjectView);
  const getSidebarState = useWorkspaceStore((state) => state.getSidebarState);
  const setSidebarOpen = useWorkspaceStore((state) => state.setSidebarOpen);
  const currentProjectPath = useProjectsStore((state) => (
    activeProjectId ? state.projects[activeProjectId]?.path : undefined
  ));

  const [isCompressing, setIsCompressing] = useState(false);

  const isHomeActive = currentView === 'home';
  const summaryTargetKey = useWorkspaceStore((state) => {
    const projectId = state.activeProjectId;
    if (!projectId) return '';
    const workspace = state.openProjects.get(projectId);
    if (!workspace) return '';
    const effectiveId = state.getEffectiveTabId();
    const tab = effectiveId ? workspace.tabs.get(effectiveId) : null;
    if (!tab || tab.tabType === 'browser') return '';
    let toolType: TimelineSummaryTool | null = null;
    let sessionId = '';
    if (tab.commandType === 'codex' && tab.codexSessionId) {
      toolType = 'codex';
      sessionId = tab.codexSessionId;
    } else if (tab.commandType === 'claude' && tab.claudeSessionId) {
      toolType = 'claude';
      sessionId = tab.claudeSessionId;
    } else if (tab.codexSessionId) {
      toolType = 'codex';
      sessionId = tab.codexSessionId;
    } else if (tab.claudeSessionId) {
      toolType = 'claude';
      sessionId = tab.claudeSessionId;
    }
    if (!toolType || !sessionId || !effectiveId) return '';
    return `${effectiveId}|${toolType}|${sessionId}`;
  });
  const summaryTarget = useMemo(() => {
    if (!summaryTargetKey) return null;
    const [tabId, toolType, sessionId] = summaryTargetKey.split('|') as [string, TimelineSummaryTool, string];
    if (!tabId || !toolType || !sessionId) return null;
    return { tabId, toolType, sessionId };
  }, [summaryTargetKey]);
  const summaryProgressByTab = useTimelineSummaryStore((state) => state.batchProgressByTab);
  const summaryGlobalAuto = useTimelineSummaryStore((state) => state.globalAuto);
  const setSummaryGlobalAuto = useTimelineSummaryStore((state) => state.setGlobalAuto);
  const summaryTabAuto = useTimelineSummaryStore((state) => (
    summaryTarget?.tabId ? state.autoByTab[summaryTarget.tabId] === true : false
  ));
  const setSummaryTabAuto = useTimelineSummaryStore((state) => state.setTabAuto);
  const summaryProgress = summaryTarget?.tabId ? summaryProgressByTab[summaryTarget.tabId] : undefined;
  const summaryRunning = summaryProgress?.running === true;
  const summaryAutoEffective = summaryGlobalAuto || summaryTabAuto;

  const summaryChipStyle = (active: boolean, disabled = false): React.CSSProperties => ({
    height: 22,
    minWidth: 32,
    padding: '0 7px',
    borderRadius: 6,
    border: `1px solid ${active ? 'rgba(56,189,248,0.7)' : 'rgba(255,255,255,0.12)'}`,
    background: active ? 'rgba(56,189,248,0.16)' : 'rgba(255,255,255,0.04)',
    color: active ? '#bae6fd' : '#8a8a8d',
    fontSize: 10,
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.62 : 1,
    fontVariantNumeric: 'tabular-nums',
  });

  const handleRefreshPromptSummaries = useCallback(() => {
    if (!summaryTarget || summaryRunning) return;
    window.dispatchEvent(new CustomEvent('timeline-summary:refresh-tab', {
      detail: { tabId: summaryTarget.tabId },
    }));
  }, [summaryTarget, summaryRunning]);

  // Get interrupted tabs for CURRENT project only
  const interruptedTabs = useMemo(() => {
    if (!activeProjectId) return [];

    const { openProjects } = useWorkspaceStore.getState();
    const workspace = openProjects.get(activeProjectId);
    if (!workspace) return [];

    const tabs: Array<{
      id: string;
      claudeSessionId?: string;
      geminiSessionId?: string;
      codexSessionId?: string;
      commandType?: string;
      cwd?: string;
    }> = [];

    workspace.tabs.forEach((tab) => {
      if (isTabInterrupted(tab)) {
        tabs.push({
          id: tab.id,
          claudeSessionId: tab.claudeSessionId,
          geminiSessionId: tab.geminiSessionId,
          codexSessionId: tab.codexSessionId,
          commandType: tab.commandType,
          cwd: tab.cwd,
        });
      }
    });

    return tabs;
  }, [interruptedTabsKey, activeProjectId]);

  // Resume all interrupted sessions
  const handleResumeAll = () => {
    if (interruptedTabs.length === 0) return;

    interruptedTabs.forEach((tab) => {
      // Clear interrupted state
      clearInterruptedState(tab.id);

      // Send resume command based on session type
      if (tab.commandType === 'codex' && tab.codexSessionId) {
        setTabCommandType(tab.id, 'codex');
        ipcRenderer.send('codex:run-command', buildCodexRunPayload({
          tabId: tab.id,
          command: 'codex-c',
          sessionId: tab.codexSessionId,
          cwd: tab.cwd,
        }));
      } else if (tab.claudeSessionId) {
        setTabCommandType(tab.id, 'claude');
        // Arm the per-tab stale-bridge guard before each resume write. Bulk-resume
        // has a higher blast radius (N tabs at once), so missing this let any stale
        // bridge file overwrite a resumed tab's sessionId. См. fix-bridge-stale-takeover.md.
        markPendingResume(tab.id, tab.claudeSessionId);
        const cmd = `claude --dangerously-skip-permissions --resume ${tab.claudeSessionId}\r`;
        ipcRenderer.send('terminal:input', tab.id, cmd);
        ipcRenderer.send('terminal:force-command-started', tab.id);
      } else if (tab.geminiSessionId) {
        setTabCommandType(tab.id, 'gemini');
        const cmd = `gemini -s ${tab.geminiSessionId}\r`;
        ipcRenderer.send('terminal:input', tab.id, cmd);
        ipcRenderer.send('terminal:force-command-started', tab.id);
      } else if (tab.codexSessionId) {
        setTabCommandType(tab.id, 'codex');
        ipcRenderer.send('codex:run-command', buildCodexRunPayload({
          tabId: tab.id,
          command: 'codex-c',
          sessionId: tab.codexSessionId,
          cwd: tab.cwd,
        }));
      }
    });

    showToast(`Resumed ${interruptedTabs.length} session(s)`, 'success');
  };

  const resolveProjectCwd = useCallback(() => {
    if (!activeProjectId) return;
    const state = useWorkspaceStore.getState();
    const workspace = state.openProjects.get(activeProjectId);
    const effectiveId = state.getEffectiveTabId();
    const currentTab = effectiveId && workspace ? workspace.tabs.get(effectiveId) : null;
    return currentTab?.cwd || currentProjectPath;
  }, [activeProjectId, currentProjectPath]);

  const handleOpenVSCode = useCallback(() => {
    const cwd = resolveProjectCwd();
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
  }, [resolveProjectCwd, showToast]);

  // Trampoline to GT Editor via custom `gteditor://open` URL scheme. macOS
  // LaunchServices routes to the already-running GT Editor.app (or cold-launches
  // it), and the receiving renderer adds the folder to its directory list if
  // missing — see gt-editor/docs/knowledge/fact-goto-modal.md.
  const handleOpenGTEditor = useCallback(() => {
    const cwd = resolveProjectCwd();
    if (!cwd) {
      showToast('Не удалось определить директорию проекта', 'error');
      return;
    }
    const { shell } = window.require('electron');
    shell.openExternal(`gteditor://open?folder=${encodeURIComponent(cwd)}`).catch((err: Error) => {
      showToast(`GT Editor: ${err.message}`, 'error');
    });
  }, [resolveProjectCwd, showToast]);

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
  }, [handleOpenGTEditor]);

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
        data-workspace-navigation
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
      <div className="flex items-center gap-1 pr-2">
        <Tooltip content="Обновить пересказы user prompts в текущей сессии">
          <button
            onClick={handleRefreshPromptSummaries}
            disabled={!summaryTarget || summaryRunning}
            style={summaryChipStyle(false, !summaryTarget || summaryRunning)}
          >
            <RefreshCw size={12} className={summaryRunning ? 'animate-spin text-sky-300' : ''} />
            {summaryRunning ? `${summaryProgress?.done || 0}/${summaryProgress?.total || 0}` : 'AI'}
          </button>
        </Tooltip>
        <Tooltip content={summaryGlobalAuto ? 'Глобальный auto включён: настройка вкладки зафиксирована' : 'Auto пересказ только новых user prompts в текущей вкладке с момента включения'}>
          <button
            onClick={() => summaryTarget && !summaryGlobalAuto && setSummaryTabAuto(summaryTarget.tabId, !summaryTabAuto)}
            disabled={!summaryTarget || summaryGlobalAuto}
            style={summaryChipStyle(summaryAutoEffective, !summaryTarget || summaryGlobalAuto)}
          >
            <Sparkles size={11} />
            tab
          </button>
        </Tooltip>
        <Tooltip content="Auto пересказ только новых user prompts во всех вкладках с момента включения">
          <button
            onClick={() => setSummaryGlobalAuto(!summaryGlobalAuto)}
            style={summaryChipStyle(summaryGlobalAuto)}
          >
            all
          </button>
        </Tooltip>
      </div>

      <div className="flex items-center pr-2">
        <ClaudeUsageButton />
      </div>

      {/* Dictation history moved OUT of the toolbar — it now opens via ⌘-click on
          the bottom-bar mic button (see MicButton.tsx / DictationHistoryPopover).
          The standalone chip was removed per user request. */}

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
