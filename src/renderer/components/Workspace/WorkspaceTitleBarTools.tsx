import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRightLeft, Check, Settings2 } from 'lucide-react';
import Tooltip from '../UI/Tooltip';
import ControlHint from '../UI/ControlHint';
import { useUIStore } from '../../store/useUIStore';
import { useWorkspaceStore, selectFocusedProjectId } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import DocsButton from './DocsButton';
import ClaudeUsageButton from './ClaudeUsageButton';
import ResourceUsageButton from './ResourceUsageButton';
import GitStatusButton from './GitStatusButton';
import TimelineToolsButton from './TimelineToolsButton';
import CopySessionWithChips from './CopySessionWithChips';
import { useTimelineSummaryStore, type TimelineSummaryTool } from '../../store/useTimelineSummaryStore';
import {
  timelineOutlineKey,
  timelineOutlineNewCount,
  useTimelineOutlineStore,
  type TimelineOutlineTarget,
} from '../../store/useTimelineOutlineStore';
import { isInboxProjectId } from '../../constants/systemProjects';
import { openTabSwitcherPanel } from './TabSwitcherOverlay';

const { ipcRenderer } = window.require('electron');
const DEFAULT_EXTERNAL_AUTO_STOP_MS = 30_000;
const DEFAULT_EXTERNAL_AUTO_CLOSE_MS = 15 * 60 * 1000;

// ============================================================================
// Кнопки рабочей области — правая часть шапки приложения.
//
// Раньше это была правая половина отдельной полосы во всю ширину окна, стоявшей
// под шапкой. Полоса удалена: её левая половина (файлы проекта, история вкладок,
// VS Code, индекс) уехала внутрь боковой панели вкладок, к своему проекту, а
// эти кнопки — сюда, наверх.
//
// Почему именно сюда: первая строка окна и так занята кнопками macOS и
// карточками проектов, но справа от карточек у неё всегда оставалось пустое
// место — оно и было отдано под перетаскивание окна. Отдельная строка ради
// десятка кнопок забирала высоту у терминала на каждом экране.
//
// Что осталось от полосы для перетаскивания: она никуда не делась, просто стала
// уже — кнопки встают слева от неё, а её ручка изменения ширины работает как
// раньше.
// ============================================================================

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

export default function WorkspaceTitleBarTools() {
  const showToast = useUIStore((state) => state.showToast);
  const focusedProjectId = useWorkspaceStore(selectFocusedProjectId);
  const centerProjectId = useWorkspaceStore((state) => state.activeProjectId);
  const isSystemProject = isInboxProjectId(focusedProjectId);

  const currentProjectMetaPath = useProjectsStore((state) => (
    focusedProjectId ? state.projects[focusedProjectId]?.path : undefined
  ));
  const currentProjectName = useProjectsStore((state) => (
    focusedProjectId ? state.projects[focusedProjectId]?.name : undefined
  ));
  const currentWorkspaceProjectPath = useWorkspaceStore((state) => {
    const projectId = selectFocusedProjectId(state);
    if (!projectId) return undefined;
    return state.openProjects.get(projectId)?.projectPath;
  });
  const currentProjectPath = currentProjectMetaPath || currentWorkspaceProjectPath;
  const centerProjectName = useProjectsStore((state) => (
    centerProjectId ? state.projects[centerProjectId]?.name : undefined
  ));

  // Рабочая директория АКТИВНОЙ вкладки — то, о чём сейчас говорит Git.
  // Строковый селектор (Fingerprint Pattern): пересчитывается на каждую запись
  // в стор, но перерисовывает только когда путь действительно изменился.
  const activeTabCwd = useWorkspaceStore((state) => {
    const projectId = state.activeProjectId;
    if (!projectId) return '';
    const workspace = state.openProjects.get(projectId);
    const tabId = state.getEffectiveTabId();
    const tab = tabId && workspace ? workspace.tabs.get(tabId) : null;
    return tab?.cwd || '';
  });

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

  const [externalSettingsOpen, setExternalSettingsOpen] = useState(false);
  const [externalStopSeconds, setExternalStopSeconds] = useState('30');
  const [externalCloseMinutes, setExternalCloseMinutes] = useState('15');
  const [externalSettingsSaving, setExternalSettingsSaving] = useState(false);
  const externalSettingsRef = useRef<HTMLDivElement | null>(null);

  const summaryTargetKey = useWorkspaceStore((state) => {
    const projectId = state.activeProjectId;
    if (!projectId) return '';
    const workspace = state.openProjects.get(projectId);
    if (!workspace) return '';
    const effectiveId = state.getEffectiveTabId();
    const tab = effectiveId ? workspace.tabs.get(effectiveId) : null;
    if (!tab) return '';
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
    if (!tab) return '';
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
      projectName: centerProjectName || null,
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
  }, [outlineTarget, outlineGenerating, generateTimelineOutline, centerProjectName, outlineError, showToast]);

  return (
    <div
      data-project-toolbar
      data-workspace-titlebar-tools
      className="flex items-center h-full"
      style={{
        gap: 6,
        // Шапка тащит окно за пустое место; кнопки — не пустое место.
        WebkitAppRegion: 'no-drag',
      } as any}
    >
      <Tooltip content="Переключить вкладку — список всех вкладок с поиском (⌘P / Ctrl+Tab)">
        <button
          data-tab-switcher-toolbar-button
          onClick={openTabSwitcherPanel}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            height: 22,
            padding: '0 8px',
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.10)',
            background: 'rgba(255,255,255,0.04)',
            color: '#9a9aa0',
            fontSize: 11,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            cursor: 'pointer',
            flexShrink: 0,
            transition: 'background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.10)';
            (e.currentTarget as HTMLElement).style.color = '#e4e4e7';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)';
            (e.currentTarget as HTMLElement).style.color = '#9a9aa0';
          }}
        >
          <ArrowRightLeft size={12} />
          <span>⌘P</span>
        </button>
      </Tooltip>

      {activeExternalRun && (
        <div ref={externalSettingsRef} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <ControlHint label="Настройки external Codex" side="bottom">
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
                flexShrink: 0,
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
                left: 0,
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

      {/* Четыре кнопки Timeline свёрнуты в ОДНУ (2026-08-17): занимать четверть
          строки постоянно им незачем — три из четырёх нажимают редко. Состояние
          видно и в свёрнутом виде, иначе работу запустили бы дважды. */}
      <TimelineToolsButton
        outline={!!outline}
        outlineNewCount={outlineNewCount}
        outlineGenerating={outlineGenerating}
        outlineDisabled={!outlineTarget}
        onGenerateOutline={handleGenerateTimelineOutline}
        summaryRunning={summaryRunning}
        summaryDone={summaryProgress?.done || 0}
        summaryTotal={summaryProgress?.total || 0}
        summaryDisabled={!summaryTarget}
        onRefreshSummaries={handleRefreshPromptSummaries}
        summaryTabAuto={summaryAutoEffective}
        summaryTabAutoLocked={summaryGlobalAuto}
        onToggleTabAuto={() => summaryTarget && !summaryGlobalAuto && setSummaryTabAuto(summaryTarget.tabId, !summaryTabAuto)}
        summaryGlobalAuto={summaryGlobalAuto}
        onToggleGlobalAuto={() => setSummaryGlobalAuto(!summaryGlobalAuto)}
      />

      {/* Потребление ресурсов проекта: вкладки с их инструментами, само
          приложение и брошенные остатки. Замер идёт только пока панель открыта. */}
      {!isSystemProject && <ResourceUsageButton />}

      <ClaudeUsageButton />

      {/* Действия с документацией (Update Docs / Update API). */}
      {!isSystemProject && <DocsButton />}

      {/* Копирование сессии. Ничего не рисует, когда у активной вкладки нет
          сессии Claude/Gemini/Codex — на обычных вкладках ряд просто короче. */}
      <CopySessionWithChips />

      {/* Git следует за директорией АКТИВНОЙ ВКЛАДКИ (2026-08-17): директория
          принадлежит вкладке, поэтому вкладка в worktree обязана показывать СВОЮ
          ветку. `projectPath` остаётся проектным — он опознаёт сохранённое
          состояние панели и список репозиториев; `tabCwd` — то, о чём статус.
          Передать путь вкладки как projectPath значило бы пересоздавать панель
          на каждом переключении и стирать наполовину написанное сообщение
          коммита. */}
      {!isSystemProject && (activeTabCwd || currentProjectPath) && (
        // Кнопка Git рисует себя во всю высоту хозяина и с прямыми углами: она
        // жила в конце полосы и упиралась в край окна. Здесь края нет, поэтому
        // высоту задаёт эта коробка, а скругление она же и обрезает — иначе
        // кнопка была бы выше соседей и с чужими углами.
        <div style={{ display: 'flex', alignItems: 'stretch', height: 24, borderRadius: 6, overflow: 'hidden', flexShrink: 0 }}>
          <GitStatusButton
            projectId={focusedProjectId}
            projectName={currentProjectName}
            projectPath={currentProjectPath}
            tabCwd={activeTabCwd}
          />
        </div>
      )}
    </div>
  );
}
