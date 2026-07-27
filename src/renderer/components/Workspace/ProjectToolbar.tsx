import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Home, Minimize2, RotateCcw, Globe, PanelLeft, FileEdit, RefreshCw, Sparkles, Settings2, Check, ListTree } from 'lucide-react';
import { VscVscode } from 'react-icons/vsc';
import { useUIStore } from '../../store/useUIStore';
import ControlHint from '../UI/ControlHint';
import Tooltip from '../UI/Tooltip';
import { useWorkspaceStore, isTabInterrupted } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { compressLogs } from '../../utils/compressLogs';
import { clearPendingResume, markPendingResume } from '../../utils/pendingResume';
import SemanticIndexButton from './SemanticIndexButton';
import CopySessionWithChips from './CopySessionWithChips';
import DocsButton from './DocsButton';
import ClaudeUsageButton from './ClaudeUsageButton';
import ResourceUsageButton from './ResourceUsageButton';
import GitStatusButton from './GitStatusButton';
import { buildCodexRunPayload } from '../../utils/codexLaunch';
import { useTimelineSummaryStore, type TimelineSummaryTool } from '../../store/useTimelineSummaryStore';
import {
  timelineOutlineKey,
  timelineOutlineNewCount,
  useTimelineOutlineStore,
  type TimelineOutlineTarget,
} from '../../store/useTimelineOutlineStore';
import { isInboxProjectId } from '../../constants/systemProjects';

const { ipcRenderer } = window.require('electron');
const DEFAULT_EXTERNAL_AUTO_STOP_MS = 30_000;
const DEFAULT_EXTERNAL_AUTO_CLOSE_MS = 15 * 60 * 1000;

type ToolbarExternalRunMeta = {
  tabId: string;
  runId?: string;
  provider?: string;
  source?: string;
  status?: string;
  autoStopMs?: number | null;
  autoCloseMs?: number | null;
  collapsed?: boolean;
};

export default function ProjectToolbar({ isSystemProject = false }: { isSystemProject?: boolean }) {
  const showToast = useUIStore((state) => state.showToast);
  const [isResumingAll, setIsResumingAll] = useState(false);
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
  const setSidebarOpen = useWorkspaceStore((state) => state.setSidebarOpen);
  const sidebarOpenForRender = useWorkspaceStore((state) => {
    const projectId = state.activeProjectId;
    if (!projectId || isInboxProjectId(projectId)) return false;
    return state.openProjects.get(projectId)?.sidebarOpen ?? false;
  });
  const currentProjectMetaPath = useProjectsStore((state) => (
    activeProjectId ? state.projects[activeProjectId]?.path : undefined
  ));
  const currentProjectName = useProjectsStore((state) => (
    activeProjectId ? state.projects[activeProjectId]?.name : undefined
  ));
  const currentWorkspaceProjectPath = useWorkspaceStore((state) => {
    const projectId = state.activeProjectId;
    if (!projectId) return undefined;
    return state.openProjects.get(projectId)?.projectPath;
  });
  const currentProjectPath = currentProjectMetaPath || currentWorkspaceProjectPath;
  const activeExternalRunKey = useWorkspaceStore((state) => {
    const projectId = state.activeProjectId;
    if (!projectId) return '';
    const workspace = state.openProjects.get(projectId);
    if (!workspace) return '';
    const effectiveId = state.getEffectiveTabId();
    const tab = effectiveId ? workspace.tabs.get(effectiveId) : null;
    const meta = (tab as any)?.externalRun;
    if (!tab) return '';
    const isInboxCodexTab = isInboxProjectId(projectId)
      && tab.commandType === 'codex'
      && String(tab.name || '').startsWith('Codex ·');
    if (!meta && !isInboxCodexTab) return '';
    const fallbackMeta = isInboxCodexTab
      ? {
        provider: 'codex',
        source: 'inbox',
        status: tab.codexSessionId ? 'idle' : 'starting',
        autoStopMs: DEFAULT_EXTERNAL_AUTO_STOP_MS,
        autoCloseMs: DEFAULT_EXTERNAL_AUTO_CLOSE_MS,
        collapsed: false,
      }
      : {};
    const resolvedMeta = { ...fallbackMeta, ...(meta || {}) };
    return JSON.stringify({
      tabId: tab.id,
      runId: resolvedMeta.runId,
      provider: resolvedMeta.provider,
      source: resolvedMeta.source,
      status: resolvedMeta.status,
      autoStopMs: resolvedMeta.autoStopMs,
      autoCloseMs: resolvedMeta.autoCloseMs,
      collapsed: resolvedMeta.collapsed === true,
    });
  });
  const activeExternalRun = useMemo<ToolbarExternalRunMeta | null>(() => {
    if (!activeExternalRunKey) return null;
    try {
      return JSON.parse(activeExternalRunKey) as ToolbarExternalRunMeta;
    } catch {
      return null;
    }
  }, [activeExternalRunKey]);

  const [isCompressing, setIsCompressing] = useState(false);
  const [externalSettingsOpen, setExternalSettingsOpen] = useState(false);
  const [externalStopSeconds, setExternalStopSeconds] = useState('30');
  const [externalCloseMinutes, setExternalCloseMinutes] = useState('15');
  const [externalSettingsSaving, setExternalSettingsSaving] = useState(false);
  const externalSettingsRef = useRef<HTMLDivElement | null>(null);

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

  const outlineTargetKey = useWorkspaceStore((state) => {
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
    return JSON.stringify({
      tabId: effectiveId,
      tabName: tab.name || null,
      toolType,
      sessionId,
      cwd: tab.cwd || workspace.projectPath || '',
      projectId,
    });
  });
  const outlineTarget = useMemo<TimelineOutlineTarget | null>(() => {
    if (!outlineTargetKey) return null;
    try {
      const parsed = JSON.parse(outlineTargetKey) as TimelineOutlineTarget;
      return parsed.tabId && parsed.toolType && parsed.sessionId ? parsed : null;
    } catch {
      return null;
    }
  }, [outlineTargetKey]);
  const outlineKey = outlineTarget
    ? timelineOutlineKey(outlineTarget.toolType, outlineTarget.sessionId)
    : '';
  const outline = useTimelineOutlineStore((state) => outlineKey ? state.outlines[outlineKey] : undefined);
  const outlineEligibleUuids = useTimelineOutlineStore((state) => outlineKey ? state.eligibleUuidsByKey[outlineKey] : undefined);
  const outlineGenerating = useTimelineOutlineStore((state) => outlineKey ? state.generatingKeys.has(outlineKey) : false);
  const outlineError = useTimelineOutlineStore((state) => outlineKey ? state.errorsByKey[outlineKey] : '');
  const loadTimelineOutline = useTimelineOutlineStore((state) => state.loadOutline);
  const generateTimelineOutline = useTimelineOutlineStore((state) => state.generateOutline);
  const outlineNewCount = timelineOutlineNewCount(outline, outlineEligibleUuids);

  useEffect(() => {
    if (!outlineTarget) return;
    void loadTimelineOutline(outlineTarget.toolType, outlineTarget.sessionId);
  }, [outlineTarget?.toolType, outlineTarget?.sessionId, loadTimelineOutline]);

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

  const outlineChipStyle = (disabled = false): React.CSSProperties => ({
    ...summaryChipStyle(!!outline, disabled),
    minWidth: 56,
    gap: 5,
    border: `1px solid ${outline ? 'rgba(192,132,252,0.65)' : 'rgba(255,255,255,0.12)'}`,
    background: outline ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.04)',
    color: outline ? '#e9d5ff' : '#a1a1aa',
  });

  useEffect(() => {
    if (!activeExternalRun) {
      setExternalSettingsOpen(false);
      return;
    }
    const stopMs = Number.isFinite(Number(activeExternalRun.autoStopMs))
      ? Number(activeExternalRun.autoStopMs)
      : DEFAULT_EXTERNAL_AUTO_STOP_MS;
    const closeMs = Number.isFinite(Number(activeExternalRun.autoCloseMs))
      ? Number(activeExternalRun.autoCloseMs)
      : DEFAULT_EXTERNAL_AUTO_CLOSE_MS;
    setExternalStopSeconds(String(Math.max(0, Math.round(stopMs / 1000))));
    setExternalCloseMinutes(String(Math.max(1, Math.round(closeMs / 60_000))));
  }, [activeExternalRun?.tabId, activeExternalRun?.runId, activeExternalRun?.autoStopMs, activeExternalRun?.autoCloseMs]);

  useEffect(() => {
    if (!externalSettingsOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const root = externalSettingsRef.current;
      if (root && !root.contains(event.target as Node)) setExternalSettingsOpen(false);
    };
    window.addEventListener('mousedown', onMouseDown, true);
    return () => window.removeEventListener('mousedown', onMouseDown, true);
  }, [externalSettingsOpen]);

  const parseExternalStopMs = useCallback(() => {
    const seconds = Number(externalStopSeconds);
    if (!Number.isFinite(seconds)) return DEFAULT_EXTERNAL_AUTO_STOP_MS;
    return Math.max(0, Math.min(24 * 60 * 60, Math.floor(seconds))) * 1000;
  }, [externalStopSeconds]);

  const parseExternalCloseMs = useCallback(() => {
    const minutes = Number(externalCloseMinutes);
    if (!Number.isFinite(minutes)) return DEFAULT_EXTERNAL_AUTO_CLOSE_MS;
    return Math.max(1, Math.min(7 * 24 * 60, Math.floor(minutes))) * 60_000;
  }, [externalCloseMinutes]);

  const saveExternalRunSettings = useCallback(async (collapsed = activeExternalRun?.collapsed === true) => {
    if (!activeExternalRun) return;
    setExternalSettingsSaving(true);
    try {
      const result = await ipcRenderer.invoke('web:update-external-run-settings', {
        tabId: activeExternalRun.tabId,
        runId: activeExternalRun.runId,
        autoStopMs: parseExternalStopMs(),
        autoCloseMs: parseExternalCloseMs(),
        collapsed,
      });
      if (result?.ok === false) {
        showToast(`Codex settings: ${result.error || 'не удалось сохранить'}`, 'error');
        return;
      }
      showToast('Настройки external Codex обновлены', 'success');
    } catch (e: any) {
      showToast(`Codex settings: ${e?.message || e}`, 'error');
    } finally {
      setExternalSettingsSaving(false);
    }
  }, [activeExternalRun, parseExternalStopMs, parseExternalCloseMs, showToast]);

  const handleRefreshPromptSummaries = useCallback(() => {
    if (!summaryTarget || summaryRunning) return;
    window.dispatchEvent(new CustomEvent('timeline-summary:refresh-tab', {
      detail: { tabId: summaryTarget.tabId },
    }));
  }, [summaryTarget, summaryRunning]);

  const handleGenerateTimelineOutline = useCallback(async () => {
    if (!outlineTarget || outlineGenerating) return;
    const record = await generateTimelineOutline({
      ...outlineTarget,
      projectName: currentProjectName || null,
    });
    if (!record) {
      const message = useTimelineOutlineStore.getState().errorsByKey[
        timelineOutlineKey(outlineTarget.toolType, outlineTarget.sessionId)
      ] || outlineError || 'Не удалось сгруппировать Timeline';
      showToast(message, 'error');
      return;
    }
    const count = record.outline.groups.length;
    const tokens = Number(record.promptTokens || 0);
    showToast(
      `${count} ${count === 1 ? 'группа' : count < 5 ? 'группы' : 'групп'}${tokens > 0 ? ` · ${tokens.toLocaleString('ru-RU')} входных токенов` : ''}`,
      'success'
    );
  }, [outlineTarget, outlineGenerating, generateTimelineOutline, currentProjectName, outlineError, showToast]);

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
  const handleResumeAll = async () => {
    if (interruptedTabs.length === 0 || isResumingAll) return;
    setIsResumingAll(true);
    try {
      const results = await Promise.all(interruptedTabs.map(async (tab) => {
        try {
          if (tab.commandType === 'codex' && tab.codexSessionId) {
            setTabCommandType(tab.id, 'codex');
            const runResult = await ipcRenderer.invoke('codex:run-command', buildCodexRunPayload({
              tabId: tab.id,
              command: 'codex-c',
              sessionId: tab.codexSessionId,
              cwd: tab.cwd,
            }));
            if (runResult?.success === false || runResult?.accepted === false) return false;
          } else if (tab.claudeSessionId) {
            setTabCommandType(tab.id, 'claude');
            // The interrupted flag remains the rollback UI until main confirms
            // that the launch bytes were accepted.
            markPendingResume(tab.id, tab.claudeSessionId);
            const runResult = await ipcRenderer.invoke('claude:run-command', {
              tabId: tab.id,
              command: 'claude-c',
              sessionId: tab.claudeSessionId,
              ...(tab.cwd ? { cdTo: tab.cwd } : {}),
            });
            if (runResult?.success === false || runResult?.accepted === false) {
              clearPendingResume(tab.id);
              return false;
            }
          } else if (tab.geminiSessionId) {
            setTabCommandType(tab.id, 'gemini');
            const cmd = `gemini -s ${tab.geminiSessionId}\r`;
            ipcRenderer.send('terminal:input', tab.id, cmd);
            ipcRenderer.send('terminal:force-command-started', tab.id);
          } else if (tab.codexSessionId) {
            setTabCommandType(tab.id, 'codex');
            const runResult = await ipcRenderer.invoke('codex:run-command', buildCodexRunPayload({
              tabId: tab.id,
              command: 'codex-c',
              sessionId: tab.codexSessionId,
              cwd: tab.cwd,
            }));
            if (runResult?.success === false || runResult?.accepted === false) return false;
          } else {
            return false;
          }
          clearInterruptedState(tab.id);
          return true;
        } catch (error) {
          if (tab.claudeSessionId) clearPendingResume(tab.id);
          console.warn('[ProjectToolbar] Resume failed tab=' + tab.id.slice(-12)
            + ' error=' + (error instanceof Error ? error.message : String(error)));
          return false;
        }
      }));
      const resumed = results.filter(Boolean).length;
      if (resumed === interruptedTabs.length) {
        showToast(`Resumed ${resumed} session(s)`, 'success');
      } else {
        showToast(`Resumed ${resumed}/${interruptedTabs.length}; failed sessions stayed paused`, 'warning');
      }
    } finally {
      setIsResumingAll(false);
    }
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
    if (isSystemProject) return;
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
  }, [isSystemProject, resolveProjectCwd, showToast]);

  // Trampoline to GT Editor via custom `gteditor://open` URL scheme. macOS
  // LaunchServices routes to the already-running GT Editor.app (or cold-launches
  // it), and the receiving renderer adds the folder to its directory list if
  // missing — see gt-editor/docs/knowledge/fact-goto-modal.md.
  const handleOpenGTEditor = useCallback(() => {
    if (isSystemProject) return;
    const cwd = resolveProjectCwd();
    if (!cwd) {
      showToast('Не удалось определить директорию проекта', 'error');
      return;
    }
    const { shell } = window.require('electron');
    shell.openExternal(`gteditor://open?folder=${encodeURIComponent(cwd)}`).catch((err: Error) => {
      showToast(`GT Editor: ${err.message}`, 'error');
    });
  }, [isSystemProject, resolveProjectCwd, showToast]);

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
      if (isSystemProject) return;
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
  }, [handleOpenGTEditor, isSystemProject]);

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
      data-project-toolbar
      className="h-[30px] w-full bg-panel flex items-stretch"
    >
      {!isSystemProject && (
        <ControlHint label={sidebarOpenForRender ? 'Скрыть файлы проекта' : 'Показать файлы проекта'} shortcut="⌘B">
        <button
          data-sidebar-toggle-trigger
          aria-pressed={sidebarOpenForRender}
          onClick={() => {
            if (!activeProjectId) return;
            setSidebarOpen(activeProjectId, !sidebarOpenForRender);
          }}
          className="h-full flex items-center px-3 text-[#666] hover:text-white hover:bg-[rgba(255,255,255,0.05)] transition-all duration-150"
          style={{
            color: sidebarOpenForRender ? '#fff' : undefined,
            backgroundColor: sidebarOpenForRender ? 'rgba(255,255,255,0.08)' : undefined,
          }}
        >
          <PanelLeft size={14} />
        </button>
        </ControlHint>
      )}

      {/* Home Button */}
      <ControlHint label={isHomeActive ? 'Вернуться в терминал' : 'Открыть Home проекта'}>
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
      </ControlHint>

      {/* Compress Logs Button */}
      <ControlHint label="Сжать логи в буфере обмена">
      <button
        onClick={handleCompressLogs}
        style={buttonStyle(false)}
        onMouseEnter={(e) => handleMouseEnter(e, false)}
        onMouseLeave={(e) => handleMouseLeave(e, false)}
        disabled={isCompressing}
      >
        <Minimize2 size={14} className={isCompressing ? 'text-indigo-400 animate-glow-indigo' : ''} />
      </button>
      </ControlHint>

      {!isSystemProject && (
        <>
          <ControlHint label="Открыть browser-вкладку">
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
          </ControlHint>

          <ControlHint label="Открыть проект в VS Code">
          <button
            onClick={handleOpenVSCode}
            style={buttonStyle(false)}
            onMouseEnter={(e) => handleMouseEnter(e, false)}
            onMouseLeave={(e) => handleMouseLeave(e, false)}
          >
            <VscVscode size={14} />
          </button>
          </ControlHint>

          <ControlHint label="Открыть проект в GT Editor" shortcut="⌘G">
          <button
            onClick={handleOpenGTEditor}
            style={buttonStyle(false)}
            onMouseEnter={(e) => handleMouseEnter(e, false)}
            onMouseLeave={(e) => handleMouseLeave(e, false)}
          >
            <FileEdit size={14} />
          </button>
          </ControlHint>

          <SemanticIndexButton
            onOpenSettings={() => {
              // App.tsx слушает settings:open и открывает SettingsModal на нужном табе.
              window.dispatchEvent(new CustomEvent('settings:open', { detail: { tab: 'colors' } }));
            }}
          />
        </>
      )}

      {/* Resume All Interrupted Sessions Button - only shows when there are interrupted tabs */}
      {interruptedTabs.length > 0 && (
        <ControlHint label={`Возобновить ${interruptedTabs.length} прерванных сессий`}>
        <button
          onClick={handleResumeAll}
          disabled={isResumingAll}
          aria-busy={isResumingAll}
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
        </ControlHint>
      )}

      {activeExternalRun && (
        <div
          ref={externalSettingsRef}
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            padding: '0 6px',
          }}
        >
          <ControlHint label="Настройки external Codex">
            <button
              onClick={() => setExternalSettingsOpen((value) => !value)}
              style={{
                height: 22,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 8px',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.12)',
                background: externalSettingsOpen ? 'rgba(56,189,248,0.14)' : 'rgba(255,255,255,0.04)',
                color: externalSettingsOpen ? '#bae6fd' : '#9ca3af',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              <Settings2 size={12} />
              <span>Настройки</span>
            </button>
          </ControlHint>

          {externalSettingsOpen && (
            <div
              style={{
                position: 'absolute',
                top: 28,
                left: 6,
                zIndex: 80,
                width: 260,
                padding: 10,
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.14)',
                background: 'rgba(16,16,20,0.96)',
                boxShadow: '0 18px 42px rgba(0,0,0,0.42)',
                color: '#e5e7eb',
                fontSize: 11,
                backdropFilter: 'blur(12px)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontWeight: 800, color: '#f8fafc' }}>External Codex</span>
                  <span style={{ color: '#8b8b91' }}>{activeExternalRun.source || 'external'} · {activeExternalRun.status || 'starting'}</span>
                </div>
                <button
                  onClick={() => saveExternalRunSettings(!(activeExternalRun.collapsed === true))}
                  disabled={externalSettingsSaving}
                  style={{
                    height: 22,
                    padding: '0 8px',
                    borderRadius: 6,
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: activeExternalRun.collapsed ? 'rgba(56,189,248,0.16)' : 'rgba(255,255,255,0.05)',
                    color: activeExternalRun.collapsed ? '#bae6fd' : '#cbd5e1',
                    fontSize: 10,
                    fontWeight: 750,
                    cursor: externalSettingsSaving ? 'default' : 'pointer',
                  }}
                >
                  {activeExternalRun.collapsed ? 'Развернуть' : 'Свернуть'}
                </button>
              </div>

              <label style={{ display: 'grid', gridTemplateColumns: '1fr 74px', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ color: '#cbd5e1' }}>Стоп процесса, сек</span>
                <input
                  type="number"
                  min={0}
                  max={24 * 60 * 60}
                  value={externalStopSeconds}
                  onChange={(e) => setExternalStopSeconds(e.target.value)}
                  style={{
                    height: 24,
                    borderRadius: 6,
                    border: '1px solid rgba(255,255,255,0.14)',
                    background: 'rgba(255,255,255,0.06)',
                    color: '#f8fafc',
                    padding: '0 7px',
                    outline: 'none',
                    fontSize: 11,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                />
              </label>

              <label style={{ display: 'grid', gridTemplateColumns: '1fr 74px', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ color: '#cbd5e1' }}>Закрыть вкладку, мин</span>
                <input
                  type="number"
                  min={1}
                  max={7 * 24 * 60}
                  value={externalCloseMinutes}
                  onChange={(e) => setExternalCloseMinutes(e.target.value)}
                  style={{
                    height: 24,
                    borderRadius: 6,
                    border: '1px solid rgba(255,255,255,0.14)',
                    background: 'rgba(255,255,255,0.06)',
                    color: '#f8fafc',
                    padding: '0 7px',
                    outline: 'none',
                    fontSize: 11,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                />
              </label>

              <button
                onClick={() => saveExternalRunSettings()}
                disabled={externalSettingsSaving}
                style={{
                  width: '100%',
                  height: 24,
                  borderRadius: 6,
                  border: '1px solid rgba(56,189,248,0.28)',
                  background: 'rgba(56,189,248,0.13)',
                  color: '#bae6fd',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  fontSize: 11,
                  fontWeight: 800,
                  cursor: externalSettingsSaving ? 'default' : 'pointer',
                  opacity: externalSettingsSaving ? 0.7 : 1,
                }}
              >
                <Check size={12} />
                {externalSettingsSaving ? 'Сохраняю' : 'Сохранить'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Flex spacer — pushes session-copy cluster to the right edge of the toolbar */}
      <div style={{ flex: 1 }} />

      {/* One adjoining Codex + Claude usage control. Each half opens the same
          downward popover on its provider; Claude prefers the official
          statusline quota payload and Codex uses the account usage endpoint. */}
      <div data-usage-summary-controls className="flex items-center gap-1 pr-2">
        <Tooltip content={outline
          ? `Пересобрать группы всей текущей сессии${outlineNewCount > 0 ? ` · новых ходов: ${outlineNewCount}` : ''}`
          : 'Сгруппировать весь Timeline текущей сессии'}>
          <button
            onClick={handleGenerateTimelineOutline}
            disabled={!outlineTarget || outlineGenerating}
            style={outlineChipStyle(!outlineTarget || outlineGenerating)}
          >
            <ListTree size={12} className={outlineGenerating ? 'animate-pulse text-purple-300' : ''} />
            <span>{outlineGenerating ? 'groups…' : 'groups'}</span>
            {!outlineGenerating && outlineNewCount > 0 && (
              <span style={{ color: '#f0abfc', fontVariantNumeric: 'tabular-nums' }}>+{outlineNewCount}</span>
            )}
          </button>
        </Tooltip>
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

      {/* Потребление ресурсов проекта: вкладки с их инструментами, само
          приложение и брошенные остатки. Замер идёт только пока панель открыта. */}
      {!isSystemProject && (
        <div className="flex min-w-0 items-center pr-2">
          <ResourceUsageButton />
        </div>
      )}

      <div className="flex min-w-0 items-center pr-2">
        <ClaudeUsageButton />
      </div>

      {/* Dictation history moved OUT of the toolbar — it now opens via ⌘-click on
          the bottom-bar mic button (see MicButton.tsx / DictationHistoryPopover).
          The standalone chip was removed per user request. */}

      {/* Docs popover trigger — opens ActionsPanel (Update Docs / Update API → Haiku
          pipeline). Pair-aligned with CopySessionWithChips popover: both anchor to
          their trigger's bottom-right edge so the two popovers share the same
          downward-opening direction. */}
      {!isSystemProject && (
        <div className="flex items-center pr-2">
          <DocsButton />
        </div>
      )}

      {/* CopySessionButton + chip-row — moved here from InfoPanel. Renders nothing
          when there's no active Claude/Gemini session, so the toolbar collapses
          gracefully on Home / generic tabs. */}
      <div className="flex items-center pr-2">
        <CopySessionWithChips />
      </div>

      {!isSystemProject && currentProjectPath && (
        <div className="flex items-stretch h-full">
          <GitStatusButton
            projectId={activeProjectId}
            projectName={currentProjectName}
            projectPath={currentProjectPath}
          />
        </div>
      )}
    </div>
  );
}
