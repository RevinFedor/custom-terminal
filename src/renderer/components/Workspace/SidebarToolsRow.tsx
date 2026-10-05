import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { History, Minimize2, PanelLeft, FileEdit, RotateCcw } from 'lucide-react';
import { VscVscode } from 'react-icons/vsc';
import ControlHint from '../UI/ControlHint';
import SemanticIndexButton from './SemanticIndexButton';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore, isTabInterrupted } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { compressLogs } from '../../utils/compressLogs';
import { clearPendingResume, markPendingResume } from '../../utils/pendingResume';
import { buildCodexRunPayload } from '../../utils/codexLaunch';
import { isInboxProjectId } from '../../constants/systemProjects';
import { SIDEBAR_TOOLS_H } from '../../constants/layout';
import {
  getSessionAvailabilitySnapshot,
  resolveTabSessionDescriptor,
} from '../../utils/sessionAvailabilityTracker';
import { sessionHistoryActionUnavailable } from '../../utils/sessionAvailabilityVisual.mjs';

const { ipcRenderer } = window.require('electron');

// ============================================================================
// Инструменты проекта — над списком вкладок, внутри боковой панели.
//
// Раньше это была левая половина полосы во всю ширину окна под шапкой (файлы
// проекта, история вкладок, сжать логи, VS Code, GT Editor, состояние индекса).
// Полоса тянулась через весь экран ради десятка кнопок и забирала высоту у
// терминала на каждом экране, при этом всё, что в ней стояло, относится к
// ОДНОМУ проекту — тому же, чей список вкладок идёт следом.
//
// Теперь кнопки стоят там, где стоит их проект: первой строкой боковой панели,
// над вкладками. Полоса во всю ширину удалена целиком.
//
// Место здесь дефицитное, поэтому кнопки идут значками с рамкой и почти без
// зазора — рамка отделяет их друг от друга вместо воздуха. Подписи нет: в
// колонке шириной 200px её просто некуда положить, объяснение живёт в
// подсказке. «История» тоже остаётся только иконкой, чтобы ряд не менял
// геометрию при сужении панели.
//
// Размер кнопки при этом ОБЩИЙ с кнопками рабочей области (Docs и соседи):
// 26px, шрифт 11. Экономить здесь на мере кнопки нельзя — две разные меры в
// одном окне читаются как два разных приложения; экономить можно на подписях,
// что мы и делаем.
// ============================================================================

interface SidebarToolsRowProps {
  projectId: string;
  presentation?: 'workspace' | 'dashboard';
  trailingControls?: React.ReactNode;
}

export default function SidebarToolsRow({ projectId, presentation = 'workspace', trailingControls }: SidebarToolsRowProps) {
  const isSystemProject = isInboxProjectId(projectId);
  const showToast = useUIStore((state) => state.showToast);

  const sidebarOpen = useWorkspaceStore((state) => (
    isInboxProjectId(projectId) ? false : state.openProjects.get(projectId)?.sidebarOpen ?? false
  ));
  const setSidebarOpen = useWorkspaceStore((state) => state.setSidebarOpen);
  const currentView = useWorkspaceStore((state) => (
    state.openProjects.get(projectId)?.currentView || 'terminal'
  ));
  const setProjectView = useWorkspaceStore((state) => state.setProjectView);
  const showWorkspace = useWorkspaceStore((state) => state.showWorkspace);
  const setTabCommandType = useWorkspaceStore((state) => state.setTabCommandType);
  const clearInterruptedState = useWorkspaceStore((state) => state.clearInterruptedState);

  const projectMetaPath = useProjectsStore((state) => state.projects[projectId]?.path);
  const workspaceProjectPath = useWorkspaceStore((state) => state.openProjects.get(projectId)?.projectPath);
  const projectPath = projectMetaPath || workspaceProjectPath;

  // Строковый ключ, а не массив: подписка на массив пересобиралась бы каждый
  // раз, когда в сторе меняется что угодно.
  const interruptedTabsKey = useWorkspaceStore((state) => {
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

  const [isCompressing, setIsCompressing] = useState(false);
  const [isResumingAll, setIsResumingAll] = useState(false);

  const isHomeActive = currentView === 'home';
  const historyActive = presentation === 'workspace' && isHomeActive;

  const handleHistoryClick = useCallback(() => {
    if (presentation === 'dashboard') {
      setProjectView(projectId, 'home');
      showWorkspace(projectId);
      return;
    }
    setProjectView(projectId, isHomeActive ? 'terminal' : 'home');
  }, [isHomeActive, presentation, projectId, setProjectView, showWorkspace]);

  const interruptedTabs = useMemo(() => {
    const workspace = useWorkspaceStore.getState().openProjects.get(projectId);
    if (!workspace) return [] as Array<{
      id: string;
      claudeSessionId?: string;
      geminiSessionId?: string;
      codexSessionId?: string;
      commandType?: string;
      cwd?: string;
    }>;
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
  }, [interruptedTabsKey, projectId]);

  // Директорию берём у вкладки ЭТОГО проекта, а не у той, что сейчас активна
  // в приложении. Панелей на экране может быть несколько, каждая со своим
  // проектом; глобально активная вкладка принадлежит одной из них, и «открыть
  // в VS Code» из чужой панели открыло бы соседнюю директорию.
  const resolveProjectCwd = useCallback(() => {
    const workspace = useWorkspaceStore.getState().openProjects.get(projectId);
    const ownTabId = workspace?.activeTabId;
    const currentTab = ownTabId ? workspace?.tabs.get(ownTabId) : null;
    return currentTab?.cwd || projectPath;
  }, [projectId, projectPath]);

  const handleOpenVSCode = useCallback(() => {
    if (isSystemProject) return;
    const cwd = resolveProjectCwd();
    if (!cwd) {
      showToast('Не удалось определить директорию проекта', 'error');
      return;
    }
    const { exec } = window.require('child_process');
    exec('code .', { cwd }, (err: Error | null) => {
      if (err) showToast('Не удалось открыть VS Code (нужен `code` в PATH)', 'error');
    });
  }, [isSystemProject, resolveProjectCwd, showToast]);

  // Прыжок в GT Editor через собственную схему ссылок `gteditor://open`. macOS
  // LaunchServices отдаёт её уже запущенному GT Editor (или запускает его), а
  // тот добавляет папку в свой список, если её там не было — см.
  // gt-editor/docs/knowledge/fact-goto-modal.md.
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

  // Cmd+G — глобальный хоткей «Открыть в GT Editor». Используем `e.code`
  // ('KeyG'), а не `e.key`: в кириллической раскладке `e.key === 'п'`, а
  // `e.code` остаётся физической клавишей. Та же конвенция, что у Cmd+T /
  // Cmd+W / Cmd+, в App.tsx.
  //
  // Хоткей висит на активном проекте, а не на каждой смонтированной панели:
  // иначе фоновые панели соседних проектов открывали бы свою директорию.
  const isFocusedProject = useWorkspaceStore((state) => (
    (state.focusedProjectId || state.activeProjectId) === projectId
  ));
  useEffect(() => {
    if (isSystemProject || !isFocusedProject) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      if (e.code !== 'KeyG') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      e.preventDefault();
      handleOpenGTEditor();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleOpenGTEditor, isSystemProject, isFocusedProject]);

  const handleCompressLogs = useCallback(async () => {
    if (isCompressing) return;
    setIsCompressing(true);
    try {
      // navigator.clipboard в production-renderer сидит на file:// и молча
      // отказывает; модуль clipboard из Electron работает безусловно.
      // См. CLAUDE.md, «Не используй navigator.clipboard в renderer».
      const { clipboard } = window.require('electron');
      const result = compressLogs(clipboard.readText());
      if (result.success) {
        clipboard.writeText(result.compressed);
        showToast(result.message, 'success');
      } else {
        showToast(result.message, 'warning');
      }
    } catch {
      showToast('Ошибка доступа к буферу обмена', 'error');
    } finally {
      setIsCompressing(false);
    }
  }, [isCompressing, showToast]);

  const handleResumeAll = useCallback(async () => {
    if (interruptedTabs.length === 0 || isResumingAll) return;
    setIsResumingAll(true);
    try {
      const results = await Promise.all(interruptedTabs.map(async (tab) => {
        try {
          const availability = getSessionAvailabilitySnapshot(resolveTabSessionDescriptor(tab, tab.id));
          if (sessionHistoryActionUnavailable(availability)) return false;
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
            // Пометка «прервана» остаётся откатом в интерфейсе, пока main не
            // подтвердит, что байты запуска приняты.
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
            ipcRenderer.send('terminal:input', tab.id, `gemini -s ${tab.geminiSessionId}\r`);
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
          console.warn('[SidebarToolsRow] Resume failed tab=' + tab.id.slice(-12)
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
  }, [interruptedTabs, isResumingAll, setTabCommandType, clearInterruptedState, showToast]);

  // Мера кнопки — та же, что у Docs и остальных кнопок рабочей области:
  // высота 26, шрифт 11, отступы 0/6. Один размер кнопки на всё приложение
  // читается как одна система; собственный мелкий размер выглядел бы
  // «второсортным» рядом с ними.
  const chipStyle = (active: boolean, disabled = false): React.CSSProperties => ({
    height: 26,
    minWidth: 26,
    padding: '0 6px',
    borderRadius: 5,
    border: `1px solid ${active ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.10)'}`,
    background: active ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.035)',
    color: active ? '#e9e9ec' : '#8a8a90',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    fontSize: 11,
    fontWeight: 600,
    flexShrink: 0,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    fontVariantNumeric: 'tabular-nums',
  });

  const hover = (event: React.MouseEvent, active: boolean, disabled = false) => {
    if (disabled || active) return;
    (event.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.09)';
    (event.currentTarget as HTMLElement).style.color = '#e9e9ec';
  };
  const unhover = (event: React.MouseEvent, active: boolean, disabled = false) => {
    if (disabled || active) return;
    (event.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.035)';
    (event.currentTarget as HTMLElement).style.color = '#8a8a90';
  };

  return (
    <div
      data-sidebar-tools-row
      data-sidebar-tools-presentation={presentation}
      className="flex items-center shrink-0 scrollbar-hide"
      style={{
        height: SIDEBAR_TOOLS_H,
        gap: 3,
        padding: '0 4px',
        whiteSpace: 'nowrap',
        flexWrap: 'nowrap',
        // Панель сужается до 140px — ряд обязан пережить это, а не выдавить
        // последнюю кнопку за край без следа. Полоса прокрутки спрятана: она
        // съела бы половину высоты ряда; обычный wheel листает ряд вбок без Shift.
        overflowX: 'hidden',
        overflowY: 'hidden',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <div data-sidebar-tools-scroll className="scrollbar-hide"
        style={{ display: 'flex', alignItems: 'center', gap: 3, flex: '1 1 auto', minWidth: 0,
          height: '100%', overflowX: 'auto', overflowY: 'hidden' }}
      onWheel={(event) => {
        const element = event.currentTarget;
        if (element.scrollWidth <= element.clientWidth) return;
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
        if (!delta) return;
        event.preventDefault();
        element.scrollLeft += delta;
      }}
    >
      {presentation === 'workspace' && !isSystemProject && (
        <ControlHint label={sidebarOpen ? 'Скрыть файлы проекта' : 'Показать файлы проекта'} shortcut="⌘B" side="bottom">
          <button
            data-sidebar-toggle-trigger
            aria-pressed={sidebarOpen}
            onClick={() => setSidebarOpen(projectId, !sidebarOpen)}
            style={chipStyle(sidebarOpen)}
            onMouseEnter={(e) => hover(e, sidebarOpen)}
            onMouseLeave={(e) => unhover(e, sidebarOpen)}
          >
            <PanelLeft size={13} />
          </button>
        </ControlHint>
      )}

      {/* Кнопка открывает вид проекта, а он показывает историю вкладок:
          закрытые сессии, поиск по ним, превью. */}
      <ControlHint
        label={presentation === 'dashboard'
          ? 'Открыть историю вкладок выбранного проекта'
          : isHomeActive ? 'Вернуться в терминал' : 'Открыть историю вкладок проекта'}
        side="bottom"
      >
        <button
          data-workspace-navigation
          data-sidebar-history-button
          onClick={handleHistoryClick}
          style={chipStyle(historyActive)}
          onMouseEnter={(e) => hover(e, historyActive)}
          onMouseLeave={(e) => unhover(e, historyActive)}
        >
          <History size={13} />
        </button>
      </ControlHint>

      {presentation === 'workspace' && <ControlHint label="Сжать логи в буфере обмена" side="bottom">
        <button
          onClick={handleCompressLogs}
          disabled={isCompressing}
          style={chipStyle(false, isCompressing)}
          onMouseEnter={(e) => hover(e, false, isCompressing)}
          onMouseLeave={(e) => unhover(e, false, isCompressing)}
        >
          <Minimize2 size={13} className={isCompressing ? 'text-indigo-400 animate-glow-indigo' : ''} />
        </button>
      </ControlHint>}

      {presentation === 'workspace' && !isSystemProject && (
        <>
          <ControlHint label="Открыть проект в VS Code" side="bottom">
            <button
              onClick={handleOpenVSCode}
              style={chipStyle(false)}
              onMouseEnter={(e) => hover(e, false)}
              onMouseLeave={(e) => unhover(e, false)}
            >
              <VscVscode size={13} />
            </button>
          </ControlHint>

          <ControlHint label="Открыть проект в GT Editor" shortcut="⌘G" side="bottom">
            <button
              onClick={handleOpenGTEditor}
              style={chipStyle(false)}
              onMouseEnter={(e) => hover(e, false)}
              onMouseLeave={(e) => unhover(e, false)}
            >
              <FileEdit size={13} />
            </button>
          </ControlHint>

          <SemanticIndexButton
            compact
            onOpenSettings={() => {
              // App.tsx слушает settings:open и открывает нужную вкладку настроек.
              window.dispatchEvent(new CustomEvent('settings:open', { detail: { tab: 'colors' } }));
            }}
          />
        </>
      )}

      {presentation === 'workspace' && interruptedTabs.length > 0 && (
        <ControlHint label={`Возобновить ${interruptedTabs.length} прерванных сессий`} side="bottom">
          <button
            onClick={handleResumeAll}
            disabled={isResumingAll}
            aria-busy={isResumingAll}
            style={chipStyle(false, isResumingAll)}
            onMouseEnter={(e) => hover(e, false, isResumingAll)}
            onMouseLeave={(e) => unhover(e, false, isResumingAll)}
          >
            <RotateCcw size={13} />
            <span style={{ color: '#93c5fd' }}>{interruptedTabs.length}</span>
          </button>
        </ControlHint>
      )}
      </div>
      {trailingControls && <div data-sidebar-tools-trailing
        style={{ display: 'flex', alignItems: 'center', flex: '0 0 auto', marginLeft: 'auto' }}>
        {trailingControls}
      </div>}
    </div>
  );
}
