import React, { memo, useCallback, useMemo, useEffect, useState, useRef } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { resolveTabTerminalPrimary, useUIStore } from '../../store/useUIStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import Terminal from './Terminal';
import ClaudeSDKTab from './ClaudeSDK/ClaudeSDKTab';
import { useSplitAttachRowHeight, splitPaneHeaderHeightVar, TAB_SURFACE_HEADER_HEIGHT_VAR, SplitDividerLayer, SplitFilePane, SplitPaneAttachRow, SplitPaneFocusFrame, splitPaneRectStyle, SPLIT_PANE_CONTENT_INSET_PX } from './SplitPaneChrome';
import {
  isEmptyPane,
  paneIsStacked,
  resolveTabPanePlacement,
  splitPanesFingerprint,
  splitSizesFingerprint,
} from '../../utils/splitPanesModel.mjs';
import { notePointerDownForDismissal } from '../../utils/overlayDismissGesture.mjs';
import SplitPaneSurface, { splitPaneQueueHostId } from './SplitPaneSurface';
import type { AgentLifecycleSummary } from './agentLifecycleSummary';
import type { SharedTabActivityMaps } from './TabSignals';
// Машина состояний запуска/остановки живёт здесь и параметризована `tabId`,
// поэтому её монтирует и одиночный режим, и каждая панель сплита отдельно.
import { useAgentLifecycle } from './useAgentLifecycle';
import { resolvePtyAgentOwner } from '../../utils/ptyAgentOwner.mjs';
import AiLaunchStrip, { type AiLaunchAction } from './AiLaunchStrip';
import { readSessionIdFromClipboard } from '../../utils/clipboardSessionId';
import { EMPTY_TAB_NAME } from '../../utils/emptyTab.mjs';
import PaneTabBodyDropZone from './PaneTabBodyDropZone';
import {
  pruneRetainedTabPanePlacements,
  resolveRetainedTabPanePlacement,
} from '../../utils/retainedTabPanePlacement.mjs';

const { ipcRenderer } = window.require('electron');

// React identity belongs to a tab, not to its current placement. A tab that
// has once owned SplitPaneSurface keeps that exact parent and geometry until
// the durable tab closes, even when plan=move temporarily removes its chip.
const retainedTabPanePlacements = new Map<string, any>();

type ExternalRunMeta = {
  runId?: string;
  provider?: string;
  source?: string;
  conversationKey?: string;
  status?: string;
  startedAt?: number;
  completedAt?: number;
  autoStopAt?: number | null;
  autoStopMs?: number | null;
  autoCloseAt?: number | null;
  autoCloseMs?: number | null;
  collapsed?: boolean;
  sessionId?: string | null;
};

type PersistentTerminalProps = Omit<
  React.ComponentProps<typeof Terminal>,
  'active' | 'isActiveProject' | 'keepPromptQueueMounted'
> & {
  actualActive: boolean;
  actualProjectActive: boolean;
  persistentPane: boolean;
};

/**
 * First presentation pays Terminal's normal hydrate/fit. Afterwards the
 * terminal remains logically mounted inside its pane and the outer singleton
 * wrapper owns visibility/inert. The 4k-line Terminal component therefore
 * does not re-render seven times merely because another space became visible.
 */
const PersistentTerminal = memo(({
  actualActive,
  actualProjectActive,
  persistentPane,
  ...terminalProps
}: PersistentTerminalProps) => {
  const [presentationPrimed, setPresentationPrimed] = useState(
    persistentPane && actualActive,
  );
  useEffect(() => {
    if (!persistentPane) {
      setPresentationPrimed(false);
      return;
    }
    if (actualActive) setPresentationPrimed(true);
  }, [actualActive, persistentPane]);
  const latched = persistentPane && presentationPrimed;
  return (
    <Terminal
      {...terminalProps}
      active={latched || actualActive}
      isActiveProject={latched || actualProjectActive}
      keepPromptQueueMounted={latched}
    />
  );
});

const statusColor = (status?: string) => {
  if (status === 'running' || status === 'sending' || status === 'starting' || status === 'stopping') return '#d97706';
  if (status === 'done' || status === 'idle') return '#22c55e';
  if (status === 'stopped') return '#94a3b8';
  if (status && status.includes('fail')) return '#ef4444';
  return '#8b5cf6';
};

const formatTtl = (target?: number | null) => {
  if (!target) return '';
  const left = Math.max(0, Math.ceil((target - Date.now()) / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
};

const ExternalRunBadge = memo(({ meta }: { meta: ExternalRunMeta }) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!meta.autoStopAt && !meta.autoCloseAt) return;
    const id = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [meta.autoStopAt, meta.autoCloseAt]);
  const stopTtl = formatTtl(meta.autoStopAt);
  const closeTtl = formatTtl(meta.autoCloseAt);
  const provider = (meta.provider || 'agent').toUpperCase();
  const source = meta.source || 'external';
  const status = meta.status || 'starting';
  if (meta.collapsed) {
    return (
      <div
        style={{
          position: 'absolute',
          left: 12,
          top: 10,
          zIndex: 18,
          width: 26,
          height: 22,
          borderRadius: 6,
          border: '1px solid rgba(255,255,255,0.12)',
          background: 'rgba(10,10,14,0.78)',
          boxShadow: '0 10px 24px rgba(0,0,0,0.32)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          backdropFilter: 'blur(10px)',
        }}
        title={[provider, source, meta.conversationKey, status].filter(Boolean).join(' · ')}
      >
        <span style={{ width: 7, height: 7, borderRadius: 999, background: statusColor(status), boxShadow: `0 0 12px ${statusColor(status)}` }} />
      </div>
    );
  }
  return (
    <div
      style={{
        position: 'absolute',
        left: 12,
        top: 10,
        zIndex: 18,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        maxWidth: 'min(520px, calc(100% - 24px))',
        padding: '6px 9px',
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,0.12)',
        background: 'rgba(10,10,14,0.78)',
        boxShadow: '0 10px 24px rgba(0,0,0,0.32)',
        color: '#e5e7eb',
        fontSize: 11,
        lineHeight: '14px',
        pointerEvents: 'none',
        backdropFilter: 'blur(10px)',
        fontVariantNumeric: 'tabular-nums',
      }}
      title={[provider, source, meta.conversationKey, status].filter(Boolean).join(' · ')}
    >
      <span style={{ width: 7, height: 7, borderRadius: 999, background: statusColor(status), boxShadow: `0 0 12px ${statusColor(status)}` }} />
      <span style={{ fontWeight: 750, letterSpacing: 0 }}>{provider}</span>
      <span style={{ color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>{source}</span>
      <span style={{ color: '#cbd5e1' }}>{status}</span>
      {stopTtl && <span style={{ color: '#fbbf24' }}>stop {stopTtl}</span>}
      {closeTtl && <span style={{ color: '#93c5fd' }}>tab {closeTtl}</span>}
    </div>
  );
});

const RestoredTerminalError = memo(({ tabId, ownerProjectId, cwd, error, visible: visibleProp }: { tabId: string; ownerProjectId: string; cwd: string; error: any; visible?: boolean }) => {
  const visibleFromStore = useWorkspaceStore((s) => {
    const ws = s.openProjects.get(ownerProjectId);
    return s.activeProjectId === ownerProjectId && ws?.activeTabId === tabId && ws?.currentView === 'terminal';
  });
  const visible = visibleProp ?? visibleFromStore;
  const isMissingCwd = error?.type === 'working_directory_missing';
  return (
    <div
      className={`absolute inset-0 ${visible ? 'flex' : 'hidden'} items-center justify-center bg-[#111113] text-[#d4d4d4]`}
      style={{ pointerEvents: visible ? 'auto' : 'none' }}
    >
      <div className="max-w-[720px] rounded-lg border border-red-500/30 bg-red-950/20 px-6 py-5 shadow-2xl">
        <div className="text-sm font-semibold uppercase tracking-wide text-red-300">
          Cannot restore terminal
        </div>
        <div className="mt-3 text-[15px] leading-6 text-[#e5e7eb]">
          {isMissingCwd
            ? 'The saved working directory no longer exists.'
            : 'The saved terminal failed before PTY creation.'}
        </div>
        <div className="mt-3 break-all rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-[#fca5a5]">
          {error?.cwd || cwd || 'unknown cwd'}
        </div>
        <div className="mt-3 text-sm text-[#a1a1aa]">
          Close this tab or recreate it in an existing folder. Other tabs and projects can still restore.
        </div>
      </div>
    </div>
  );
});

// Типы состояния запуска/остановки и сборка его текста переехали в
// `useAgentLifecycle` вместе с самой машиной. Копии здесь удалены намеренно: две
// формулировки одного статуса разъехались бы при первой правке подписи, и одна
// поверхность тихо осталась бы с прежним текстом.

// The floating lifecycle CARD (AgentLifecycleStatusCard + its two wrappers,
// SessionStartingOverlay and AgentStoppingOverlay) lived here and was removed:
// the transcript's own status control already says the same thing, in the
// surface that owns the session. See the note at its former render site below.
//
// What is kept is the STATE behind it — sessionStarting / agentStopping and the
// lifecycleSummary built from them — because that state is what every surface
// now reads, including panes.

// Declared in its own module (./agentLifecycleSummary) because SplitPaneSurface
// consumes it and this file renders SplitPaneSurface. Re-exported here so the
// existing importers keep working.
export type { AgentLifecycleSummary };

interface TerminalAreaProps {
  projectId: string;
  terminalPresented?: boolean;
  promptQueuePortalHostId?: string;
  hidePromptQueueHistoryToggle?: boolean;
  promptQueueInputSurface?: 'terminal' | 'history';
  onLifecycleStatusChange?: (status: AgentLifecycleSummary | null) => void;
  sharedActivity?: SharedTabActivityMaps | null;
}

function TerminalArea({
  projectId,
  terminalPresented = true,
  promptQueuePortalHostId,
  hidePromptQueueHistoryToggle = false,
  promptQueueInputSurface = 'terminal',
  onLifecycleStatusChange,
  sharedActivity = null,
}: TerminalAreaProps) {
  const viewingSubAgentTabId = useWorkspaceStore((s) => s.openProjects.get(projectId)?.viewingSubAgentTabId ?? null);

  // DEBUG: Track TerminalArea mount/unmount lifecycle
  useEffect(() => {
    console.warn('[TerminalArea:MOUNT] projectId=', projectId);
    return () => {
      console.warn('[TerminalArea:UNMOUNT] projectId=', projectId);
    };
  }, []);

  // Targeted selectors — avoid subscribing to entire openProjects Map
  const createTab = useWorkspaceStore((state) => state.createTab);
  const currentView = useWorkspaceStore((s) => s.openProjects.get(projectId)?.currentView || 'terminal');
  const activeTabId = useWorkspaceStore((s) => s.openProjects.get(projectId)?.activeTabId ?? null);
  const activeExternalRun = useWorkspaceStore((s) => {
    const ws = s.openProjects.get(projectId);
    if (!ws?.activeTabId) return null;
    return ((ws.tabs.get(ws.activeTabId) as any)?.externalRun || null) as ExternalRunMeta | null;
  });
  // Состояние запуска/остановки СВОЕЙ вкладки. Машина переехала в
  // `useAgentLifecycle`: она параметризована `tabId`, поэтому каждая видимая
  // вкладка держит свой экземпляр. Здесь — экземпляр для одиночного режима
  // (центральная поверхность проекта); панели сплита монтируют свои сами.
  //
  // Раньше эта машина жила прямо тут в единственном экземпляре и читала
  // `activeTabId`, из-за чего плашка процесса не строилась для неактивной
  // вкладки вообще — не «скрывалась», а отсутствовала.
  const lifecycleSummary = useAgentLifecycle({
    projectId,
    tabId: activeTabId,
    enabled: currentView === 'terminal',
  });

  useEffect(() => {
    onLifecycleStatusChange?.(lifecycleSummary);
  }, [lifecycleSummary, onLifecycleStatusChange]);

  useEffect(() => () => {
    onLifecycleStatusChange?.(null);
  }, [onLifecycleStatusChange]);

  // DEBUG: Track render reason
  const renderCountRef = useRef(0);
  renderCountRef.current++;

  // Check if sub-agent is actively visible (parent Gemini tab is the active tab)
  const isSubAgentVisible = useWorkspaceStore((s) => {
    if (!viewingSubAgentTabId) return false;
    const ws = s.openProjects.get(projectId);
    if (!ws?.activeTabId) return false;
    const viewedTab = ws.tabs.get(viewingSubAgentTabId);
    return !!viewedTab && (viewedTab as any).parentTabId === ws.activeTabId;
  });

  if ((window as any).__NOTED_RENDER_DIAG__ === true) {
    console.warn(`[TerminalArea:RENDER #${renderCountRef.current}] projectId=${projectId} currentView=${currentView}`);
  }

  // Stable string selector — re-renders only when tab structure changes or a
  // tab changes its own rendered surface. Active project/tab visibility is
  // tracked separately below so project switches do not remount xterm.
  const terminalFingerprint = useWorkspaceStore((s) => {
    const parts: string[] = [];
    s.openProjects.forEach((workspace, projId) => {
      const subAgentPart = projId === projectId && workspace.viewingSubAgentTabId
        ? `:sub=${workspace.viewingSubAgentTabId}:host=${workspace.activeTabId || ''}`
        : '';
      parts.push(`${projId}${subAgentPart}`);
      workspace.tabs.forEach((tab) => {
        parts.push(`${tab.id}:${tab.tabType || 'terminal'}:${(tab as any).restoreError ? 'restore-error' : 'ok'}`);
      });
    });
    return parts.join(',');
  });

  // Active layer is intentionally separate from the structural fingerprint.
  // Terminals stay mounted across project switches, but the visible DOM layer
  // must be driven by one fresh store snapshot so an old project cannot keep
  // `active=1`/opacity=1 after the active project changes.
  const activeLayerKey = useWorkspaceStore((s) => {
    const activeProjectId = s.activeProjectId || '';
    const workspace = activeProjectId ? s.openProjects.get(activeProjectId) : null;
    return [
      s.view,
      activeProjectId,
      workspace?.activeTabId || '',
      workspace?.currentView || '',
      workspace?.viewingSubAgentTabId || '',
      // Split composition/focus — pane wrappers restyle without remounts. The
      // model owns this identity: [] and [empty] MUST differ, as must a hidden
      // chip joining a strip while its shown tab stays unchanged.
      splitPanesFingerprint(s.splitPanes),
      String(s.splitFocusedIndex),
      // Divider positions: committed once per finished drag (the live drag
      // moves the DOM directly), so this rebuild runs once per drag, and a
      // LATER rebuild repaints the wrappers at the dragged sizes instead of
      // snapping them back to the equal split.
      splitSizesFingerprint(s.splitSizes),
      // Persistent Terminal/History wrappers keep pane FORM for hidden
      // workflows too. A hidden layout mutation therefore changes the memo
      // even when the visible panes happen to have the same tab ids.
      s.activeSpaceId,
      s.spaces.map((space) => (
        space.id === s.activeSpaceId
          ? `${space.id}=live`
          : `${space.id}=${splitPanesFingerprint(space.layout?.splitPanes || [])}@${splitSizesFingerprint(space.layout?.splitSizes || null)}`
      )).join(';'),
    ].join('|');
  });

  // Split pane click-to-focus. Capture phase: the pane must become the app's
  // active tab BEFORE the click lands in xterm/composer, so keyboard focus and
  // toolbar follow-through never lag one click behind.
  const splitPaneCount = useWorkspaceStore((s) => s.splitPanes.length);
  const focusedEmptyPaneIndex = useWorkspaceStore((s) => (
    s.splitPanes.length > 0 && isEmptyPane(s.splitPanes[s.splitFocusedIndex])
      ? s.splitFocusedIndex
      : -1
  ));
  useEffect(() => {
    if (splitPaneCount === 0) return;
    const onPointerDown = (e: PointerEvent) => {
      // LEFT button only. A right-click opens a menu ABOUT something; a middle
      // click removes something. Neither is "I want to work in this pane", and
      // moving focus on them yanked the surface out from under the menu the
      // user had just opened. Same rule as the pane header chip.
      if (e.button !== 0) return;
      // An overlay is open → this click belongs to IT: its job is to close the
      // menu, not to work in whatever is underneath. Checked here because this
      // listener is on pointerdown in the CAPTURE phase, while every dismiss
      // handler is on mousedown in the bubble phase — so focus always won the
      // race and the dismissal looked like a deliberate click into the pane.
      // (Reported: right-click pane 1's chip from pane 2, then click inside
      // pane 1 — the menu closed AND pane 1 took focus.)
      if (notePointerDownForDismissal(document)) return;
      // Маркеры статусов и их меню НЕ двигают фокус окон: их смысл — «сменить
      // цвет, ничего не активируя» (юзер: «при этом фокус не меняется вообще
      // никак»). Гашение события на самой кнопке сюда не достаёт: этот
      // обработчик стоит на window в capture-фазе и срабатывает раньше цели,
      // поэтому исключение живёт здесь, по data-атрибутам.
      if ((e.target as HTMLElement)?.closest?.(
        '[data-tab-status-marker-button], [data-tab-status-marker-menu], [data-task-plan-status-trigger], [data-task-plan-status-menu]',
      )) return;
      // Focus changes the header's RIGHT boundary because Git+split enters the
      // layout. Do not do that between pointerdown and click for a chip/badge:
      // the target near the reclaimed edge would move out from under mouseup.
      // Chips focus through activateCenterTab in their click handler; overflow
      // badges focus after their own stable click inside PaneTabStrip.
      if ((e.target as HTMLElement)?.closest?.(
        '[data-split-pane-tab-chip], [data-strip-overflow]',
      )) {
        useUIStore.getState().setActiveArea('workspace');
        return;
      }
      const el = (e.target as HTMLElement)?.closest?.('[data-split-pane-index]');
      if (!el) return;
      if (e.button === 0) useUIStore.getState().setActiveArea('workspace');
      const idx = Number(el.getAttribute('data-split-pane-index'));
      const st = useWorkspaceStore.getState();
      // The click both FOCUSES the pane and reaches whatever is under it.
      //
      // There used to be a swallow here: the first click into an unfocused pane
      // only selected it, so a stray hit could not expand a thinking block as a
      // side effect of "go here". Removed by request (2026-08-17) — in practice
      // it read as a dead click, and the accidental expansion it prevented is
      // cheaper to undo than a click that does nothing.
      // ⌘-клик — «прицелиться в окно, не съезжая из чужого проекта»: двигает
      // только рамку фокуса, боковое меню и центр остаются как есть. Нужен,
      // когда человек стоит в другом проекте и выбирает, КУДА оттуда положить
      // вкладку: обычный клик сменил бы проект вместе со списком, из которого
      // он и собирался выбирать.
      if (Number.isFinite(idx) && idx !== st.splitFocusedIndex) {
        st.focusSplitPane(idx, e.metaKey ? { keepSidebar: true } : undefined);
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [splitPaneCount]);

  useEffect(() => {
    if (focusedEmptyPaneIndex < 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const activeElement = document.activeElement;
      if (activeElement && activeElement !== document.body) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      useWorkspaceStore.getState().removeEmptySplitPane(focusedEmptyPaneIndex);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [focusedEmptyPaneIndex]);

  // Боковые панели-«гости» окон. Открытая панель выезжает за границу своего
  // окна поверх соседнего, поэтому обёртка окна должна ПОДНИМАТЬСЯ над
  // соседями — а для этого memo обязан пересчитаться в момент открытия или
  // закрытия панели, не при следующей перестройке по другому поводу.
  const terminalIsPrimaryTabs = useUIStore((s) => s.terminalIsPrimaryTabs);
  const newTabPrimarySurface = useUIStore((s) => s.newTabPrimarySurface);
  const sideTerminalOpenTabs = useUIStore((s) => s.sideTerminalOpenTabs);
  const historyPanelOpenTabs = useUIStore((s) => s.historyPanelOpenTabs);

  // Header row height follows the chip's Settings-driven size. Read OUTSIDE
  // the memo and listed in its deps: a header that grew while the memo held a
  // stale 26 is exactly the chip-over-the-separator bug.
  const attachRowH = useSplitAttachRowHeight();

  // Запуск агента из ШАПКИ ПУСТОГО ОКНА.
  //
  // Полоса кнопок — та же, что в баре новой вкладки (AiLaunchStrip), но здесь
  // ей некуда приземлиться: вкладки в этом окне ещё нет, а превращать чужую
  // (как делает бар, стоящий ВНУТРИ вкладки) тут нечего. Поэтому создаём новую
  // вкладку в конце списка проекта и она сама встаёт в это окно: панель в
  // фокусе принимает активируемую вкладку — то самое общее правило активации,
  // которым пользуются и боковой список, и Ctrl+Tab.
  //
  // Проект берём у ОКНА, а не «активный»: окна кросс-проектные, и вкладка,
  // созданная в чужом проекте, выглядела бы как чужая папка в чужом списке.
  // Пустое окно своего проекта не помнит, поэтому спрашиваем боковое меню —
  // это и есть «где я сейчас работаю».
  const launchIntoEmptyPane = useCallback(async (
    paneIndex: number,
    action: AiLaunchAction,
  ) => {
    const store = useWorkspaceStore.getState();
    const targetProjectId = store.getFocusedProjectId() || store.activeProjectId;
    if (!targetProjectId) return;
    const workspace = store.openProjects.get(targetProjectId);
    if (!workspace) return;
    // Окно должно быть в фокусе ДО создания вкладки: активация кладёт её именно
    // в сфокусированное окно, а кликнуть могли по кнопке в шапке соседнего.
    if (store.splitFocusedIndex !== paneIndex) store.focusSplitPane(paneIndex);

    // `createTab` only creates/persists a tab. Its direct activeTabId write does
    // not update splitPanes, so relying on activation here produced the exact
    // split-brain the user saw: the sidebar selected the new tab while the
    // empty pane still had no tab id. Create in background, then make the pane
    // placement the single visible commit.
    const placeInTargetPane = (createdTabId: string) => {
      if (!createdTabId) return;
      const current = useWorkspaceStore.getState();
      if (current.splitPanes[paneIndex]) {
        current.addTabToSplitPaneStrip(paneIndex, targetProjectId, createdTabId);
      } else {
        // The user may have removed the placeholder while PTY creation was in
        // flight. Do not leave a live tab unreachable; ordinary activation is
        // the safe fallback and the sidebar visibility guard will expose it.
        current.activateCenterTab(targetProjectId, createdTabId);
      }
    };

    const projectPath = workspace.projectPath && !workspace.projectPath.startsWith('__unset__')
      ? workspace.projectPath
      : '';
    const activeTab = workspace.activeTabId ? workspace.tabs.get(workspace.activeTabId) : null;
    const cwd = projectPath || activeTab?.cwd || '';

    if (action === 'terminal') {
      // Вкладка без агента: живой shell. Отдельного типа вкладки нет — «пустая»
      // это описание, а не состояние (см. emptyTab.mjs). Обычная строка в
      // боковом списке: вкладка, спрятанная из него, теряет второй способ до
      // себя добраться и становится недостижимой, когда чип уходит из полосы.
      const createdTabId = await useWorkspaceStore.getState().createTabAfterCurrent(targetProjectId, EMPTY_TAB_NAME, cwd, {
        skipInitialRename: true,
        background: true,
        afterTabId: activeTab?.id,
        visualParentTabId: '',
      });
      placeInTargetPane(createdTabId);
      return;
    }
    if (action === 'sdk') {
      const createdTabId = await useWorkspaceStore.getState().createSDKTab(targetProjectId, undefined, {
        background: true,
      });
      placeInTargetPane(createdTabId);
      return;
    }
    if (action === 'claude' || action === 'codex') {
      // Тот же контракт, что у всех прочих точек запуска: вкладка несёт
      // pendingAction, а CLI поднимает Terminal.tsx, когда shell готов. Свой
      // запуск отсюда гонялся бы с ним и стартовал два процесса в одном PTY.
      const createdTabId = await useWorkspaceStore.getState().createTabAfterCurrent(targetProjectId, undefined, cwd, {
        color: action,
        pendingAction: { type: action === 'codex' ? 'codex-new' : 'claude-new' },
        skipInitialRename: true,
        background: true,
        afterTabId: activeTab?.id,
        visualParentTabId: '',
      });
      placeInTargetPane(createdTabId);
      return;
    }
    // Форки из буфера: без UUID в буфере создавать вкладку незачем — пустая
    // вкладка «на всякий случай» это мусор, который пользователь не просил.
    const clipSid = readSessionIdFromClipboard();
    if (!clipSid) {
      useUIStore.getState().showToast('В буфере нет session ID (UUID)', 'warning');
      return;
    }
    if (action === 'sdk-fork') {
      const forkResult = await ipcRenderer.invoke('claude:fork-session-file', {
        sourceSessionId: clipSid,
        cwd,
        skipChainResolve: true,
      });
      if (!forkResult?.success) {
        useUIStore.getState().showToast('Fork failed: ' + (forkResult?.error || 'unknown'), 'error');
        return;
      }
      const sdkTabId = await useWorkspaceStore.getState().createSDKTab(
        targetProjectId,
        `${clipSid.slice(0, 8)}_fork`,
        { background: true },
      );
      useWorkspaceStore.getState().updateSDKState(sdkTabId, { claudeSessionId: forkResult.newSessionId });
      placeInTargetPane(sdkTabId);
      return;
    }
    const isCodex = action === 'codex-fork';
    const createdTabId = await useWorkspaceStore.getState().createTabAfterCurrent(
      targetProjectId,
      `${clipSid.slice(0, 8)}_${isCodex ? 'codex' : 'fork'}`,
      cwd,
      {
        color: isCodex ? 'codex' : 'claude',
        pendingAction: { type: isCodex ? 'codex-fork' : 'claude-fork', sessionId: clipSid },
        nameSetManually: false,
        skipInitialRename: true,
        background: true,
        afterTabId: activeTab?.id,
        visualParentTabId: '',
      },
    );
    placeInTargetPane(createdTabId);
  }, []);

  const terminals = useMemo(() => {
    const t0 = Date.now();
    const result: React.ReactNode[] = [];
    const state = useWorkspaceStore.getState();
    const currentOpenProjects = state.openProjects;
    const activeProjectId = state.activeProjectId;
    const appView = state.view;
    // Split workspace: pane tabs render side-by-side; every OTHER layer keeps
    // its normal mount but is forced inactive. Wrapper divs are persistent
    // (same key/type in both modes) so entering/leaving the split never
    // remounts xterm.
    const splitPanes = state.splitPanes;
    const splitSizes = state.splitSizes;
    const splitActive = splitPanes.length > 0;
    // Окна ДРУГИХ пространств. Нужны здесь не чтобы что-то показать, а чтобы
    // вкладка, разложенная там, СОХРАНИЛА форму окна и в этом пространстве:
    // форма — структура дерева, и её переворот при каждом переключении заставлял
    // React сносить и собирать окна заново вместе с живым терминалом
    // (см. resolveTabPanePlacement).
    const hiddenSpaceLayouts = state.spaces
      .filter((space: any) => space.id !== state.activeSpaceId)
      .map((space: any) => ({
        id: space.id,
        splitPanes: space?.layout?.splitPanes || [],
        splitSizes: space?.layout?.splitSizes || null,
      }));
    const activeSpaceLayout = {
      id: state.activeSpaceId,
      splitPanes,
      splitSizes,
    };
    const splitFocusedTabId = splitActive ? (splitPanes[state.splitFocusedIndex]?.tabId || null) : null;
    // Куда рисуется вкладка. ПЕРВОЕ окно, а не последнее: вся разметка окна —
    // шапка, содержимое, рамка фокуса — рендерится вкладкой, которую окно
    // показывает, поэтому тихая перезапись оставляла бы предыдущее окно вообще
    // без разметки: чёрный прямоугольник без шапки, «окно тупо пропало».
    // Состояния «одна вкладка в двух окнах» быть не должно — модель снимает
    // дубликат и при добавлении, и при восстановлении сессии, — поэтому если он
    // всё же дошёл сюда, он должен быть ГРОМКИМ, а не невидимым.
    const paneIndexByTabId = new Map<string, number>();
    splitPanes.forEach((p, i) => {
      if (!p.tabId) return; // намеренно пустое окно
      const already = paneIndexByTabId.get(p.tabId);
      if (already !== undefined) {
        console.warn('[TerminalArea] duplicate pane tab=' + p.tabId.slice(-12)
          + ' panes=' + already + ',' + i + ' — rendering in ' + already);
        return;
      }
      paneIndexByTabId.set(p.tabId, i);
    });
    let sdkCount = 0;
    let totalCount = 0;
    const liveTabIds = new Set<string>();
    currentOpenProjects.forEach((workspace) => {
      workspace.tabs.forEach((tab) => liveTabIds.add(tab.id));
    });
    pruneRetainedTabPanePlacements(retainedTabPanePlacements, liveTabIds);

    const isActiveProjectForLayer = (projId: string) => (
      appView === 'workspace' && activeProjectId === projId
    );

    const isActiveTerminalLayer = (projId: string, tabId: string) => {
      if (!isActiveProjectForLayer(projId)) return false;
      const workspace = currentOpenProjects.get(projId);
      if (!workspace || workspace.currentView !== 'terminal') return false;

      if (workspace.viewingSubAgentTabId) {
        const viewedTab = workspace.tabs.get(workspace.viewingSubAgentTabId);
        if (viewedTab && viewedTab.parentTabId === workspace.activeTabId) {
          return tabId === workspace.viewingSubAgentTabId;
        }
      }

      return workspace.activeTabId === tabId;
    };

    currentOpenProjects.forEach((workspace, projId) => {
      workspace.tabs.forEach((tab) => {
        // ФОРМА (окно раскладки / одиночный центр) и МЕСТО (какое окно и где
        // оно лежит) — разные вопросы, и раньше на оба отвечало одно число.
        //
        // Форма — это СТРУКТУРА дерева. Пока её считали по одному видимому
        // пространству, она переворачивалась дважды на ровном месте: вкладка,
        // ушедшая в чипы своего окна, и вкладка соседнего пространства
        // «переставали быть окном», и React был обязан снести и собрать заново
        // всё поддерево окна вместе с живым терминалом. На проде это стоило
        // 200–330мс сплошной блокировки на клик плюс повторную заливку буферов
        // (до 920КБ на вкладку) — при том, что сама раскладка пересчитывается
        // за 0–1мс.
        //
        // Поэтому форму держит раскладка ВСЕХ пространств: вкладка, разложенная
        // хоть в одном окне, всегда рисуется как окно. Место остаётся за
        // видимым пространством — окно чужого пространства (или чип своего)
        // стоит на месте, но не показывается и номера окна не имеет.
        //
        // Только пока видимое пространство САМО разложено окнами: в одиночном
        // центре форма окна никому не нужна, а мини-рабочая-область на каждой
        // из сотни вкладок стоила бы дороже, чем экономит.
        const visiblePaneIndex = splitActive ? (paneIndexByTabId.get(tab.id) ?? -1) : -1;
        const shownInPane = visiblePaneIndex >= 0;
        const livePanePlacement = splitActive
          ? resolveTabPanePlacement(tab.id, activeSpaceLayout, hiddenSpaceLayouts)
          : null;
        // `plan=move` removes the outgoing tab from splitPanes before inserting
        // the incoming one. Treating that temporary absence as “not a pane
        // surface” changed its React parent to raw `inner`, disposing Terminal,
        // Timeline and History despite warm caches. Once created, the tab-owned
        // parent keeps its last exact rect while hidden; a real later placement
        // replaces the retained geometry in place.
        const panePlacement = resolveRetainedTabPanePlacement(
          retainedTabPanePlacements,
          tab.id,
          livePanePlacement,
          splitActive,
        );
        const inPane = panePlacement !== null;
        const layoutPaneIndex = panePlacement?.paneIndex ?? -1;
        const layoutPanes = panePlacement?.panes || splitPanes;
        const layoutSizes = panePlacement?.sizes || null;
        const paneRect = inPane
          ? splitPaneRectStyle(layoutPaneIndex, layoutPanes, layoutSizes)
          : { position: 'absolute' as const, inset: 0 };
        const paneStacked = inPane && paneIsStacked(layoutPanes, layoutPaneIndex);
        const paneGeometryKey = inPane
          ? [paneRect.left, paneRect.width, paneRect.top, paneRect.height, paneStacked ? 'stacked' : 'single'].join('|')
          : 'single-centre';
        // In split mode ONLY pane tabs are visible; each pane tab renders
        // regardless of which project is globally active.
        // Активность — про ВИДИМОЕ окно: вкладка скрытого пространства
        // отрисована, но не показана и ничем не владеет.
        // Активность — про ПОКАЗАННОЕ окно: вкладка-чип и вкладка чужого
        // пространства отрисованы, но ничем не владеют и не видны.
        const isActiveProject = splitActive
          ? (shownInPane && appView === 'workspace')
          : isActiveProjectForLayer(projId);
        const active = splitActive
          ? (shownInPane && appView === 'workspace')
          : isActiveTerminalLayer(projId, tab.id);

        let inner: React.ReactNode = null;
        if (tab.tabType === 'claude-sdk') {
          sdkCount++;
          totalCount++;
          inner = (
            <ClaudeSDKTab
              key={tab.id}
              tabId={tab.id}
              cwd={tab.cwd}
              ownerProjectId={projId}
              active={active}
              isActiveProject={isActiveProject}
            />
          );
        } else if (tab.tabType === 'file') {
          totalCount++;
          // Single mode: linked file tabs render through the global
          // FilePreview overlay in Workspace (no PTY layer, nothing here).
          // Split mode: the pane hosts its own read-only markdown surface —
          // the global overlay is a window-wide singleton and would cover
          // the neighbouring panes.
          if (!shownInPane) return;
          inner = (
            <SplitFilePane
              key={tab.id}
              filePath={tab.filePath || ''}
              visible={active}
            />
          );
        } else if ((tab as any).restoreError) {
          totalCount++;
          inner = (
            <RestoredTerminalError
              key={tab.id}
              tabId={tab.id}
              ownerProjectId={projId}
              cwd={tab.cwd}
              error={(tab as any).restoreError}
              visible={active}
            />
          );
        } else {
          totalCount++;
          // A pane owns its Run after strip: the overlay portals into the
          // pane's own host (z-layer of the PANE, not of the terminal), and
          // agent panes always author through History (docked or inline
          // composer), same as the single-mode agent layouts.
          const paneAgentPair = inPane && resolvePtyAgentOwner(tab) !== null;
          inner = (
            <PersistentTerminal
              key={tab.id}
              tabId={tab.id}
              cwd={tab.cwd}
              ownerProjectId={projId}
              actualActive={active}
              actualProjectActive={isActiveProject}
              persistentPane={inPane}
              presented={terminalPresented}
              promptQueuePortalHostId={inPane ? splitPaneQueueHostId(tab.id) : promptQueuePortalHostId}
              hidePromptQueueHistoryToggle={inPane ? paneAgentPair : hidePromptQueueHistoryToggle}
              promptQueueInputSurface={inPane
                ? (paneAgentPair ? 'history' : 'terminal')
                : promptQueueInputSurface}
            />
          );
        }

        // Persistent per-TAB wrapper: single mode = full-size transparent
        // layer, split mode = pane content rect. Pane chrome/focus frame live in
        // one stable per-WINDOW sibling below; putting them here remounted the
        // whole header and reset strip scroll on every chip switch.
        // pointerEvents:none — each tab surface re-enables its own hits when
        // presented, so hidden full-size wrappers never shadow panes below.
        const focusedPane = shownInPane && tab.id === splitFocusedTabId;
        // Открыта ли у окна боковая панель-«гость» (терминал при
        // переписке-primary, переписка при терминале-primary). Считается тем же
        // правилом, что в SplitPaneSurface::sideOverlayOpen — по одному вопросу
        // на одно состояние.
        const paneOverlayOpen = shownInPane
          && tab.tabType !== 'claude-sdk'
          && tab.tabType !== 'file'
          && resolvePtyAgentOwner(tab) !== null
          && (resolveTabTerminalPrimary({ terminalIsPrimaryTabs, newTabPrimarySurface }, tab.id)
            ? !!historyPanelOpenTabs[tab.id]
            : !!sideTerminalOpenTabs[tab.id]);
        result.push(
          <div
            key={`pane:${tab.id}`}
            data-terminal-pane-wrapper={tab.id}
            {...(shownInPane ? { 'data-split-pane-index': visiblePaneIndex } : {})}
            inert={inPane && !shownInPane}
            style={{
              ...paneRect,
              // Окно чужого пространства СТОИТ НА МЕСТЕ и остаётся
              // РАСТРИРОВАННЫМ в собственном compositor-layer. `visibility`
              // сохранял размеры, но выкидывал пиксели: возврат заставлял
              // Chromium заново красить 2/5 больших History DOM-деревьев и всё
              // ещё давал 207–330мс long task после того, как React/IPC работа
              // уже была устранена. Opacity меняет только композицию готовых
              // слоёв. display:none по-прежнему запрещён — он схлопнул бы 0×0
              // и убил графический контекст терминала.
              //
              // Раз оно живое, оно обязано быть невидимым и для КЛАВИАТУРЫ:
              // построенная переписка держит своё поле ввода, и Tab уводил бы
              // курсор в окно, которого человек не видит (ровно тот шрам, что
              // закрыт `inert` у закрытой боковой панели терминала).
              ...(inPane ? {
                opacity: shownInPane ? 1 : 0,
                visibility: 'visible' as const,
                willChange: 'opacity',
                transition: 'none',
              } : null),
              // Окно с открытой боковой панелью поднимается над соседями:
              // панели позволено лечь поверх соседнего окна (гость, а не
              // колонка). Наверху — окно, в котором работают: сфокусированное
              // встаёт выше обычных окон (2), линий делителей (5) и меток
              // бокового списка вкладок (до 10) — панель накрывает и сам
              // список, так попрошено («терминал должен перекрывать боковое
              // меню»). Потерявшее фокус окно опускается ПОД обычные, чтобы
              // его панель не закрывала окно, в котором человек работает
              // сейчас, — там она снова выглядит обрезанной границей, ровно
              // пока смотрят не на неё. Клик по видимой части окна возвращает
              // его наверх (клик и так фокусирует окно). Выше остаются только
              // настоящие оверлеи: ProjectHome (50) и меню (100030).
              zIndex: shownInPane
                ? (paneOverlayOpen ? (focusedPane ? 12 : 1) : 2)
                : (splitActive ? 0 : 1),
              pointerEvents: 'none',
            }}
          >
            {/* Toast anchor of THIS tab. A toast about this tab is portalled here,
                so it appears at the top-right of the surface it is about instead
                of the top-right of the whole window (where a message about the
                left pane landed over the right one). Empty box, no hit-testing:
                the toast itself re-enables pointer events. */}
            <div
              data-toast-anchor-tab-id={tab.id}
              style={{
                position: 'absolute',
                // Ниже ШАПКИ этого окна. Число измеренное, а не предсказанное:
                // в режиме переноса вкладок шапка выше на столько строк,
                // сколько заняли чипы. Запасное значение — прежнее
                // предсказание по настройкам, на случай окна без своей шапки.
                top: inPane
                  ? `calc(var(${TAB_SURFACE_HEADER_HEIGHT_VAR}, var(${splitPaneHeaderHeightVar(layoutPaneIndex)}, ${attachRowH}px)) + 8px)`
                  : 8,
                right: 8,
                zIndex: 210,
                pointerEvents: 'none',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                gap: 8,
                maxWidth: 'min(420px, calc(100% - 16px))',
              }}
            />
            <div
              data-terminal-pane-content
              style={{
                position: 'absolute',
                // Та же измеренная высота шапки — см. комментарий у якоря
                // уведомлений выше.
                top: inPane
                  ? `var(${TAB_SURFACE_HEADER_HEIGHT_VAR}, var(${splitPaneHeaderHeightVar(layoutPaneIndex)}, ${attachRowH}px))`
                  : 0,
                // A pane's content stops 2px short of the frame. The frame is a
                // 1px line drawn ON the pane's edge; content that reaches the
                // same pixel column touches it, and anything light there — a
                // scrollbar thumb, the Timeline's rail — visually fuses with the
                // line, so the frame reads as noticeably thicker on that side
                // than on the other three. (Reported: "the white frame looks
                // thicker on the left where the scroll is".) Two pixels is
                // enough to separate them and small enough to cost no layout.
                left: inPane ? SPLIT_PANE_CONTENT_INSET_PX : 0,
                right: inPane ? SPLIT_PANE_CONTENT_INSET_PX : 0,
                bottom: 0,
                pointerEvents: 'none',
              }}
            >
              {inPane && tab.tabType !== 'file' ? (
                <SplitPaneSurface
                  projectId={projId}
                  tabId={tab.id}
                  focused={focusedPane}
                  // Статус процесса панель собирает САМА, по своему `tabId`.
                  // Раньше он приходил отсюда пропом, но строился только для
                  // активной вкладки — то есть во второй панели его не было
                  // никогда, сколько бы она ни фильтровала по `tabId`.
                  stacked={paneStacked}
                  // Окно чужого пространства держит ФОРМУ и терминал, но не
                  // монтирует свои тяжёлые поверхности (переписку, таймлайн,
                  // план, панель управления): их там некому смотреть, а цена —
                  // ровно те сотни миллисекунд, ради которых всё это делается.
                  dormant={!shownInPane}
                  paneIndex={Math.max(0, layoutPaneIndex)}
                  geometryKey={paneGeometryKey}
                >
                  {inner}
                </SplitPaneSurface>
              ) : inner}
              {(shownInPane || (!inPane && active)) && (
                <PaneTabBodyDropZone paneIndex={inPane ? visiblePaneIndex : null} />
              )}
            </div>
          </div>
        );
      });
    });

    // One chrome tree per WINDOW, not per shown tab.
    //
    // The header used to live inside `pane:${tab.id}` above. Switching a chip
    // therefore unmounted the old PaneTabStrip and mounted a new one with
    // scrollLeft=0; Git/split/⋮ were physically replaced too. From the user's
    // side this looked exactly like focus-dependent disappearing actions and
    // a strip that forgot its horizontal position. The stable pane-index key
    // keeps one scroller/actions row while only its shown tab prop changes.
    splitPanes.forEach((pane, paneIndex) => {
      if (isEmptyPane(pane)) return;
      const tab = currentOpenProjects.get(pane.projectId)?.tabs.get(pane.tabId);
      if (!tab) return;
      const focusedPane = paneIndex === state.splitFocusedIndex;
      const paneOverlayOpen = tab.tabType !== 'claude-sdk'
        && tab.tabType !== 'file'
        && resolvePtyAgentOwner(tab) !== null
        && (resolveTabTerminalPrimary({ terminalIsPrimaryTabs, newTabPrimarySurface }, tab.id)
          ? !!historyPanelOpenTabs[tab.id]
          : !!sideTerminalOpenTabs[tab.id]);
      result.push(
        <div
          key={`pane:chrome:${paneIndex}`}
          data-terminal-pane-chrome-host={paneIndex}
          data-split-pane-index={paneIndex}
          style={{
            ...splitPaneRectStyle(paneIndex, splitPanes, splitSizes),
            zIndex: paneOverlayOpen ? (focusedPane ? 12 : 1) : 2,
            pointerEvents: 'none',
          }}
        >
          <SplitPaneAttachRow
            projectId={pane.projectId}
            tabId={pane.tabId}
            focused={focusedPane}
            paneIndex={paneIndex}
            sharedActivity={sharedActivity}
          />
          <SplitPaneFocusFrame focused={focusedPane} />
        </div>
      );
    });

    splitPanes.forEach((pane, paneIndex) => {
      if (!isEmptyPane(pane)) return;
      const focusedPane = paneIndex === state.splitFocusedIndex;
      result.push(
        <div
          key={`pane:empty:${paneIndex}`}
          data-terminal-pane-wrapper="empty"
          data-split-pane-index={paneIndex}
          style={{
            ...splitPaneRectStyle(paneIndex, splitPanes, splitSizes),
            zIndex: 2,
            pointerEvents: 'none',
            background: '#161616',
          }}
        >
          <div
            data-split-attach-row
            // Двойной клик по пустому месту шапки — то же, что в шапке обычного
            // окна: ещё одна вкладка сюда. Пустое окно только выглядит иначе,
            // жест один.
            onDoubleClick={(e) => {
              e.stopPropagation();
              launchIntoEmptyPane(paneIndex, 'terminal');
            }}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: attachRowH,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 8px',
              boxSizing: 'border-box',
              zIndex: 3,
              pointerEvents: 'auto',
              color: '#8a8a8f',
              fontSize: 11,
              fontWeight: 600,
              userSelect: 'none',
            }}
          >
            {/* Шапка пустого окна называет ЕГО состояние, а кнопки запуска
                переехали вниз, в центр (см. ниже): полоса из шести кнопок в
                строке заголовка выглядела как содержимое окна, хотя окно пустое.
                Юзер: *«кнопки… тогда переносите вниз, если у меня ничего нет —
                это будет более логично»*. */}
            <span style={{ color: '#6f6f75', fontWeight: 500 }}>Нет вкладки</span>
            <span style={{ flex: 1 }} />
            <button
              title="Убрать пустую панель"
              onClick={(e) => {
                e.stopPropagation();
                useWorkspaceStore.getState().removeEmptySplitPane(paneIndex);
              }}
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                width: 18,
                height: 18,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                border: 'none',
                borderRadius: 4,
                background: 'transparent',
                color: '#8f8f94',
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
          <div
            // Двойной клик по телу — тот же жест, что по шапке: всё окно пустое,
            // и требовать попасть именно в верхние 26 пикселей было бы правилом
            // без причины.
            onDoubleClick={(e) => {
              e.stopPropagation();
              launchIntoEmptyPane(paneIndex, 'terminal');
            }}
            style={{
              position: 'absolute',
              top: attachRowH,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              padding: 16,
              background: '#161616',
              color: '#777',
              fontSize: 12.5,
              textAlign: 'center',
              pointerEvents: 'auto',
              userSelect: 'none',
            }}
          >
            <PaneTabBodyDropZone paneIndex={paneIndex} />
            {/* ТА ЖЕ полоса запуска, что в баре вкладки — один компонент, не
                копия. Здесь она ВЕДУЩАЯ (рисует и чип Claude): живой сессии в
                пустом окне нет, а значит нет и её отдельной кнопки управления,
                рядом с которой чип оказался бы вторым. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
              <AiLaunchStrip
                ownsClaudeChip
                // Здесь полоса СОЗДАЁТ «Пустую вкладку» с live shell. Внутри
                // уже созданной вкладки terminal-action скрыт.
                showTerminal
                onLaunch={(action) => launchIntoEmptyPane(paneIndex, action)}
              />
            </div>
            <div style={{ color: '#5f5f65', fontSize: 11.5 }}>
              Двойной клик — пустая вкладка · Ctrl+Tab / Cmd+P или клик по вкладке слева
            </div>
          </div>
          <SplitPaneFocusFrame focused={focusedPane} />
        </div>
      );
    });

    const durMs = Date.now() - t0;
    console.warn(`[TerminalArea:useMemo] RECALCULATING projectId=${projectId.slice(-12)} total=${totalCount} sdk=${sdkCount} split=${splitPanes.length} durMs=${durMs}`);
    return result;
    // lifecycleSummary is a dependency, not a captured constant: panes read the
    // agent's start/stop status from it, and without it here a pane would keep
    // rendering the status from whenever this memo last ran.
  }, [terminalFingerprint, activeLayerKey, projectId, terminalPresented, promptQueuePortalHostId, hidePromptQueueHistoryToggle, promptQueueInputSurface, lifecycleSummary, attachRowH, terminalIsPrimaryTabs, newTabPrimarySurface, sideTerminalOpenTabs, historyPanelOpenTabs, sharedActivity]);

  // Listen for Claude fork completion to create new tab with command
  useEffect(() => {
    const handleForkComplete = async (_: any, data: { success: boolean; newSessionId?: string; cwd?: string; error?: string }) => {
      console.log('[TerminalArea] Fork complete received:', data);
      if (!data.success || !data.newSessionId || !data.cwd) {
        console.error('[TerminalArea] Fork failed:', data.error);
        return;
      }

      // Create new tab with pending command
      const pendingCommand = `claude --dangerously-skip-permissions --resume ${data.newSessionId}`;
      console.log('[TerminalArea] Creating new tab with command:', pendingCommand);

      // Find project that contains this cwd (read fresh state)
      const currentOpenProjects = useWorkspaceStore.getState().openProjects;
      let targetProjectId: string | null = null;
      currentOpenProjects.forEach((workspace, projId) => {
        if (workspace.projectPath === data.cwd || data.cwd?.startsWith(workspace.projectPath)) {
          targetProjectId = projId;
        }
      });

      if (!targetProjectId) {
        targetProjectId = projectId;
      }

      await createTab(targetProjectId, 'Claude Fork', data.cwd, {
        pendingCommand,
        claudeSessionId: data.newSessionId
      });
    };

    ipcRenderer.on('claude:fork-complete', handleForkComplete);
    return () => {
      ipcRenderer.removeListener('claude:fork-complete', handleForkComplete);
    };
  }, [createTab, projectId]);

  // Handle double-click on empty space to create new tab
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      const project = useProjectsStore.getState().projects[projectId];
      if (project) createTab(projectId, undefined, project.path);
    }
  };

  // Render terminals for ALL open projects to prevent unmount/remount on project switch
  // This keeps terminal instances alive and prevents jitter
  return (
    <div
      data-terminal-area-root
      className="absolute inset-0 bg-bg-main"
      onDoubleClick={handleDoubleClick}
    >
      {/* Render all terminals from all projects */}
      {terminals}

      {/* Divider grab strips OVER the pane boundaries. Sibling of the pane
          wrappers on purpose: the live drag walks parentElement to reposition
          them without a store write per mousemove. */}
      <SplitDividerLayer />

      {currentView === 'terminal' && activeExternalRun && (
        <ExternalRunBadge meta={activeExternalRun} />
      )}

      {/* Orange border overlay when viewing sub-agent */}
      {isSubAgentVisible && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            boxShadow: 'inset 0 0 0 2px rgba(204, 120, 50, 0.4)',
            borderRadius: '4px',
            zIndex: 10,
          }}
        />
      )}

      {/* The floating "LOADING … SESSION" card used to live here. Removed:
          the same status is already carried by the transcript's own status
          control (HistoryPanel → activeLifecycle), which shows the title, the
          error text and both the dismiss and RETRY buttons — so the card was a
          second answer to a question already answered, in a place that did not
          belong to the tab it described.
          Two concrete costs: it was anchored to the whole window rather than
          to its pane, so in a split it appeared over a NEIGHBOUR's area; and
          its 400px box sat across the pane header, swallowing right-clicks on
          the tab chip underneath. The status now lives inside the surface that
          owns the session — including in panes, which is what the
          lifecycleStatus prop on SplitPaneSurface is for. */}

    </div>
  );
}

export default memo(TerminalArea);
