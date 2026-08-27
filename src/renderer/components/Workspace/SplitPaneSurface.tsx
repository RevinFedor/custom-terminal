import React, { startTransition, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWorkspaceStore, type CommandType } from '../../store/useWorkspaceStore';
import { resolveTabTerminalPrimary, useUIStore } from '../../store/useUIStore';
import HistoryPanel, {
  HISTORY_SURFACE_PRESENTATION_EVENT,
  type HistoryInitialSourceSignal,
} from './HistoryPanel';
import TabTaskPlanPanel from './TabTaskPlanPanel';
import { type TimelineInitialSourceSignal } from './Timeline';
import PersistentPaneTimeline from './PersistentPaneTimeline';
import ClaudeControlBar from './ClaudeControlBar';
import FloatingTerminalFrame from './FloatingTerminalFrame';
import { useAgentLifecycle } from './useAgentLifecycle';
import { resolvePtyAgentOwner } from '../../utils/ptyAgentOwner.mjs';
import { useCodexSurfaceReadSessionId } from '../../hooks/useCodexSurfaceReadSessionId';
import { markRendererActivity } from '../../utils/rendererActivityTrail';
import {
  getStartupRestoreProgress,
  subscribeStartupRestoreProgress,
} from '../../utils/startupRestoreProgress.mjs';
import { PANE_LAYER_PRESENTATION_EVENT } from '../../utils/paneLayerPresentation.mjs';
import { createDormantSurfaceAdmissionQueue } from '../../utils/dormantSurfaceAdmission.mjs';
import { historyForegroundPriority } from '../../utils/historyForegroundPriority.mjs';

const { ipcRenderer } = window.require('electron');

// Per-pane portal hosts. The Run after strip and the docked composer belong to
// the PANE, not to the terminal layer — hiding or dimming the terminal must
// never take them along.
export const splitPaneQueueHostId = (tabId: string) => `split-pane-queue-host-${tabId}`;

// ── Прогрев окон ЧУЖИХ пространств ──
//
// Поверхности строятся один раз и живут дальше (см. surfacesAwake ниже). Один
// frame между START'ами оказался ложной сериализацией: History/Timeline после
// mount продолжали subscribe/get-history/projector ещё 5–23 секунды, пока
// следующие окна уже стартовали. Admission ниже держит ровно одну скрытую
// heavy activation до exact source completion; после release следующий job
// снова проходит через idle boundary.
type DormantAdmissionWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

const scheduleDormantSurfaceAdmission = (callback: () => void) => {
  const idleWindow = window as DormantAdmissionWindow;
  let cancelled = false;
  let idleId: number | null = null;
  let frameId = 0;
  const afterIdle = () => {
    void historyForegroundPriority.waitForBackgroundSlot({
      shouldBypass: () => cancelled,
    }).then(() => {
      if (cancelled) return;
      frameId = requestAnimationFrame(() => {
        frameId = 0;
        if (!cancelled && !historyForegroundPriority.active()) callback();
        else if (!cancelled) afterIdle();
      });
    });
  };
  if (typeof idleWindow.requestIdleCallback === 'function') {
    idleId = idleWindow.requestIdleCallback(afterIdle, { timeout: 5000 });
  } else {
    frameId = requestAnimationFrame(() => {
      frameId = 0;
      if (!cancelled) callback();
    });
  }
  return () => {
    cancelled = true;
    if (idleId !== null) idleWindow.cancelIdleCallback?.(idleId);
    if (frameId) cancelAnimationFrame(frameId);
  };
};

const dormantSurfaceAdmission = createDormantSurfaceAdmissionQueue({
  schedule: scheduleDormantSurfaceAdmission,
  timeoutMs: 60_000,
  onTransition: (event: any) => {
    console.warn('[Perf:PanePrewarmAdmission] phase=' + event.phase
      + ' tab=' + String(event.key || '').split(':').pop()?.slice(-12)
      + ' token=' + (event.token || 0)
      + ' pending=' + (event.pending ?? 0)
      + (event.reason ? ' reason=' + event.reason : ''));
  },
});

type PanePrewarmConfig = {
  sessionId: string;
  historyRequired: boolean;
  timelineRequired: boolean;
  timelineLoadRequired: boolean;
  timelineSubscribeRequired: boolean;
};

const panePrewarmRequirements = (config: PanePrewarmConfig) => {
  const requirements = new Set<string>();
  if (config.historyRequired) {
    requirements.add('history:load');
    requirements.add('history:subscribe');
  }
  if (config.timelineRequired) {
    if (config.timelineLoadRequired) requirements.add('timeline:load');
    if (config.timelineSubscribeRequired) requirements.add('timeline:subscribe');
  }
  return requirements;
};


export const splitPaneComposerHostId = (tabId: string) => `split-pane-composer-host-${tabId}`;

interface SplitPaneSurfaceProps {
  projectId: string;
  tabId: string;
  focused: boolean;
  /** This pane shares its column with another, so it is roughly half height. */
  stacked?: boolean;
  /**
   * Окно ЧУЖОГО (сейчас не показанного) пространства.
   *
   * Оно отрисовано только затем, чтобы форма окна — а с ней и живой терминал
   * внутри — пережила переключение пространств без пересборки. Смотреть в него
   * некому, поэтому свои тяжёлые поверхности (переписка, таймлайн, план задач,
   * панель управления) оно не монтирует: именно их постройка и стоила тех
   * сотен миллисекунд, ради которых форма и делалась постоянной.
   */
  dormant?: boolean;
  /** Номер окна в видимой раскладке — очередь постройки поверхностей. */
  paneIndex?: number;
  /** Exact inner geometry. Equal across hide/show means scroll needs no restore. */
  geometryKey?: string;
  children: ReactNode;
}

type PersistentPaneHistoryProps = Omit<
  React.ComponentProps<typeof HistoryPanel>,
  'presented' | 'preservePresentationGeometry' | 'presentationExternallyManaged' | 'presentationChannel'
> & {
  actualPresented: boolean;
  presentationChannel: string;
  presentationGeometryStable: boolean;
};

/**
 * Presentation ownership is external from the FIRST physical mount.
 *
 * The old two-stage contract mounted a dormant History with
 * `presentationExternallyManaged=false`, then flipped it to `true` on first
 * visibility. `HistoryPanel` quite correctly uses different physical Virtuoso
 * keys for those modes, so the flip destroyed the DOM that background prewarm
 * had just built. The first workflow visit therefore paid the whole mount wave
 * again even though its rows were already loaded.
 *
 * Keep both heavy props constant from mount onward. `initialPresentedRef` is
 * only the stable React seed (true for an initially visible pane, false for a
 * dormant one); the exact subsequent state is delivered by the channel below
 * and HistoryPanel restores its diagnostic DOM attributes in the same layout
 * commit. Hidden panes can now build pixels without acquiring
 * scroll/input/presentation ownership.
 */
function PersistentPaneHistory({
  actualPresented,
  presentationChannel,
  presentationGeometryStable,
  ...historyProps
}: PersistentPaneHistoryProps) {
  const initialPresentedRef = useRef(actualPresented);
  useLayoutEffect(() => {
    window.dispatchEvent(new CustomEvent(HISTORY_SURFACE_PRESENTATION_EVENT, {
      detail: {
        channel: presentationChannel,
        presented: actualPresented,
        geometryStable: presentationGeometryStable,
      },
    }));
  }, [actualPresented, presentationChannel, presentationGeometryStable]);
  return (
    <HistoryPanel
      {...historyProps}
      presented={initialPresentedRef.current}
      preservePresentationGeometry={presentationGeometryStable}
      presentationExternallyManaged
      presentationChannel={presentationChannel}
    />
  );
}

/**
 * A split pane is a FULL mini-workspace, not a viewport: every pane owns its
 * terminal+input, or an AI transcript with its composer, plus its own Run
 * after strip, Timeline column, task panel and control bar. Focus decides only
 * two things — the white frame and which pane owns GLOBAL hotkeys (Escape
 * interrupt, Cmd+F). Both panes stay fully interactive.
 *
 * The xterm subtree is never removed: in transcript mode the terminal lives in
 * the pane's own side frame (docked to THIS pane's right edge), hidden
 * off-edge while closed.
 */
export default function SplitPaneSurface({
  projectId,
  tabId,
  focused,
  stacked = false,
  dormant = false,
  paneIndex = 0,
  geometryKey = '',
  children,
}: SplitPaneSurfaceProps) {
  const previousGeometryKeyRef = useRef(geometryKey);
  const presentationGeometryStable = previousGeometryKeyRef.current === geometryKey;
  useLayoutEffect(() => {
    previousGeometryKeyRef.current = geometryKey;
  }, [geometryKey]);
  const tabType = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.tabType);
  const commandType = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.commandType || null);
  const claudeSessionId = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.claudeSessionId || '');
  const geminiSessionId = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.geminiSessionId || '');
  const codexSessionId = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.codexSessionId || '');
  const codexReadSessionId = useCodexSurfaceReadSessionId(commandType === 'codex' ? tabId : null);
  const codexSurfaceSessionId = codexSessionId || codexReadSessionId || '';
  const tabName = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.name || 'Terminal');
  const cwd = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.cwd || '');
  const aiBusy = useWorkspaceStore((state) => state.openProjects.get(projectId)?.tabs.get(tabId)?.aiBusy === true);
  const projectPath = useWorkspaceStore((state) => state.openProjects.get(projectId)?.projectPath || cwd);
  const workspaceVisible = useWorkspaceStore((state) => state.view === 'workspace');
  const externalPresentationRef = useRef({
    presented: workspaceVisible && !dormant,
    focused,
  });
  // A pane may stay mounted forever after background prewarm. `focused` is
  // deliberately NOT used: every visible split pane may own its scroll even
  // when another pane owns global hotkeys. Dormant means genuinely off-screen.
  const historySurfacePresented = externalPresentationRef.current.presented;

  // Поверхности окна СТРОЯТСЯ ОДИН РАЗ и живут дальше — как терминал.
  //
  // История решения. Сначала окна чужих пространств вообще не строили своих
  // поверхностей (переписку, таймлайн, панель управления): их никто не видит,
  // а строятся они дорого. Потом, чтобы вход в пространство не собирал пять
  // комплектов в одном кадре, постройку растянули по кадрам. Оба варианта
  // упирались в одно и то же: переключение всё равно ЧТО-ТО делает, значит
  // мгновенным оно не бывает.
  //
  // Пользователь выбрал третий вариант: «нужно всё-таки, чтобы у меня
  // переключение пространств было мгновенным… чтобы оно жило как бы на фоне».
  // Поэтому поверхность, once построенная, больше не разбирается: окно чужого
  // пространства или временно вытесненной вкладки остаётся в точной геометрии,
  // а внешняя обёртка в TerminalArea меняет только opacity + inert. Вернуться
  // в него — это показать готовое, ноль повторного mount/hydrate в кадре.
  //
  // Первая постройка всё ещё платится — но только одной hidden heavy surface
  // за раз и только пока окно НИ РАЗУ не показывали. Следующая получает lease
  // после exact load+subscribe completion; дальше `awoken` больше не гаснет.
  //
  // Цена размена (обсуждена и принята): панели скрытых пространств остаются
  // подписаны на свои сессии, поэтому те не «паркуются» в main. Память —
  // десятки мегабайт на окно, не гигабайты: сами записи и так лежат в общем
  // хранилище в одном экземпляре.
  type HeavyActivationPhase = 'cold' | 'history' | 'timeline' | 'ready';
  const [surfacesAwake, setSurfacesAwake] = useState(() => !dormant);
  const [heavyActivationPhase, setHeavyActivationPhase] = useState<HeavyActivationPhase>(
    () => dormant ? 'cold' : 'ready',
  );
  const surfacesAwakeRef = useRef(surfacesAwake);
  surfacesAwakeRef.current = surfacesAwake;
  const heavyActivationPhaseRef = useRef<HeavyActivationPhase>(heavyActivationPhase);
  heavyActivationPhaseRef.current = heavyActivationPhase;
  const admissionKey = 'pane:' + projectId + ':' + tabId;
  const admissionTrackerRef = useRef<{
    lease: any;
    sessionId: string;
    requirements: Set<string>;
    settled: Set<string>;
    startedAt: number;
    endMark: (() => void) | null;
    timeout: number | null;
  } | null>(null);

  // Панель СОБИРАЕТ состояние своей вкладки сама, а не получает пропом сверху.
  //
  // Раньше сводка приходила из `TerminalArea` в одном экземпляре и строилась для
  // АКТИВНОЙ вкладки, а панель лишь фильтровала её по `tabId`. Фильтр был верным,
  // но фильтровать было нечего: для неактивной вкладки состояние не строилось
  // вовсе, поэтому во второй панели сплита «CLAUDE START FAILED» не появлялся
  // никогда. Свой экземпляр машины на панель — единственный способ сделать
  // плашку свойством процесса, а не фокуса.
  // Машина «запускается / не запустился / останавливается» следует тому же
  // правилу, что и поверхности: пока окно не построили — не подписываемся,
  // после — живёт, включая скрытые пространства. Иначе возврат в пространство
  // снова стоил бы опроса состояний.
  const paneLifecycleStatus = useAgentLifecycle({
    projectId,
    tabId,
    enabled: workspaceVisible && surfacesAwake,
  });
  const terminalIsPrimary = useUIStore((state) => resolveTabTerminalPrimary(state, tabId));
  const setTabTerminalIsPrimary = useUIStore((state) => state.setTabTerminalIsPrimary);
  const historyPanelWidth = useUIStore((state) => state.historyPanelWidth);
  const notesPanelWidth = useUIStore((state) => state.notesPanelWidth);
  const timelinePinned = useUIStore((state) => state.timelinePinned);
  const sideTerminalOpen = useUIStore((state) => state.sideTerminalOpenTabs[tabId] ?? false);
  const setSideTerminalOpen = useUIStore((state) => state.setSideTerminalOpen);
  const sideHistoryOpen = useUIStore((state) => state.historyPanelOpenTabs[tabId] ?? false);
  const setHistoryPanelOpen = useUIStore((state) => state.setHistoryPanelOpen);

  const ptyAgentOwner = resolvePtyAgentOwner({
    commandType,
    claudeSessionId,
    codexSessionId: codexSurfaceSessionId,
  });
  const isCodex = ptyAgentOwner === 'codex';
  const isAgentTab = tabType !== 'claude-sdk'
    && tabType !== 'file'
    && ptyAgentOwner !== null;
  const historySelected = isAgentTab && !terminalIsPrimary;
  const agentSessionId = isCodex ? codexSurfaceSessionId : claudeSessionId;
  const agentToolType: 'claude' | 'codex' = isCodex ? 'codex' : 'claude';

  // Timeline follows any session the tab has (agent PTY, SDK, gemini).
  const timelineToolType: 'claude' | 'gemini' | 'codex' = isCodex
    ? 'codex'
    : (commandType === 'gemini' || (!claudeSessionId && !!geminiSessionId)) ? 'gemini' : 'claude';
  const timelineSessionId = timelineToolType === 'codex'
    ? codexSurfaceSessionId
    : timelineToolType === 'gemini' ? geminiSessionId : claudeSessionId;
  const showTimeline = !!timelineSessionId;

  const prewarmConfigRef = useRef({
    sessionId: agentSessionId || timelineSessionId || '',
    historyRequired: isAgentTab && !!agentSessionId,
    timelineRequired: showTimeline,
    timelineLoadRequired: showTimeline,
    timelineSubscribeRequired: showTimeline && timelineToolType !== 'gemini',
  });
  prewarmConfigRef.current = {
    sessionId: agentSessionId || timelineSessionId || '',
    historyRequired: isAgentTab && !!agentSessionId,
    timelineRequired: showTimeline,
    timelineLoadRequired: showTimeline,
    timelineSubscribeRequired: showTimeline && timelineToolType !== 'gemini',
  };

  const completeAdmission = useCallback((reason: string) => {
    const tracker = admissionTrackerRef.current;
    if (!tracker) return;
    admissionTrackerRef.current = null;
    if (tracker.timeout !== null) window.clearTimeout(tracker.timeout);
    tracker.timeout = null;
    heavyActivationPhaseRef.current = 'ready';
    startTransition(() => setHeavyActivationPhase('ready'));
    tracker.endMark?.();
    console.warn('[Perf:PanePrewarm] phase=complete tab=' + tabId.slice(-12)
      + ' pane=' + paneIndex
      + ' reason=' + reason
      + ' durMs=' + (performance.now() - tracker.startedAt).toFixed(1));
    tracker.lease.complete(reason);
  }, [paneIndex, tabId]);

  const maybeAdvanceAdmission = useCallback(() => {
    const tracker = admissionTrackerRef.current;
    if (!tracker) return;
    const historyPending = Array.from(tracker.requirements)
      .some((requirement) => requirement.startsWith('history:') && !tracker.settled.has(requirement));
    const timelineRequirements = Array.from(tracker.requirements)
      .filter((requirement) => requirement.startsWith('timeline:'));
    if (!historyPending && heavyActivationPhaseRef.current === 'history') {
      if (timelineRequirements.some((requirement) => !tracker.settled.has(requirement))) {
        heavyActivationPhaseRef.current = 'timeline';
        startTransition(() => setHeavyActivationPhase('timeline'));
        console.warn('[Perf:PanePrewarm] phase=timeline-admitted tab=' + tabId.slice(-12)
          + ' pane=' + paneIndex);
      }
    }
    const pending = Array.from(tracker.requirements)
      .filter((requirement) => !tracker.settled.has(requirement));
    if (pending.length === 0) completeAdmission('initial-source-settled');
  }, [completeAdmission, paneIndex, tabId]);

  const settleAdmissionRequirement = useCallback((
    requirement: string,
    signalSessionId: string | null,
    status: string,
  ) => {
    const tracker = admissionTrackerRef.current;
    if (!tracker) return;
    const signalSession = signalSessionId || '';
    if (tracker.sessionId && tracker.sessionId !== signalSession) {
      const currentConfig = prewarmConfigRef.current;
      // A completion from the old owner cannot release this lease. If the
      // signal names the pane's CURRENT owner, rebase the same lease onto that
      // owner and wait for its complete source set instead of burning 55s.
      if (!currentConfig.sessionId || currentConfig.sessionId !== signalSession) return;
      tracker.sessionId = currentConfig.sessionId;
      tracker.requirements = panePrewarmRequirements(currentConfig);
      tracker.settled.clear();
      console.warn('[Perf:PanePrewarm] phase=owner-rebase tab=' + tabId.slice(-12)
        + ' pane=' + paneIndex
        + ' requirements=' + (Array.from(tracker.requirements).join(',') || 'none'));
      if (tracker.requirements.size === 0) {
        completeAdmission('owner-no-heavy-source');
        return;
      }
      if (!currentConfig.historyRequired && heavyActivationPhaseRef.current === 'history') {
        heavyActivationPhaseRef.current = 'timeline';
        startTransition(() => setHeavyActivationPhase('timeline'));
      }
    }
    if (!tracker.requirements.has(requirement)) return;
    if (tracker.settled.has(requirement)) return;
    tracker.settled.add(requirement);
    console.warn('[Perf:PanePrewarm] phase=signal tab=' + tabId.slice(-12)
      + ' pane=' + paneIndex
      + ' requirement=' + requirement
      + ' status=' + status
      + ' remaining=' + Math.max(0, tracker.requirements.size - tracker.settled.size));
    maybeAdvanceAdmission();
  }, [completeAdmission, maybeAdvanceAdmission, paneIndex, tabId]);

  const handleHistoryInitialSourceSignal = useCallback((signal: HistoryInitialSourceSignal) => {
    settleAdmissionRequirement('history:' + signal.phase, signal.sessionId, signal.status);
  }, [settleAdmissionRequirement]);

  const handleTimelineInitialSourceSignal = useCallback((signal: TimelineInitialSourceSignal) => {
    settleAdmissionRequirement('timeline:' + signal.phase, signal.sessionId, signal.status);
  }, [settleAdmissionRequirement]);

  const startBackgroundPrewarm = useCallback((lease: any) => {
    const config = prewarmConfigRef.current;
    const requirements = panePrewarmRequirements(config);
    const phase: HeavyActivationPhase = config.historyRequired
      ? 'history'
      : config.timelineRequired ? 'timeline' : 'ready';
    const startedAt = performance.now();
    const tracker = {
      lease,
      sessionId: config.sessionId,
      requirements,
      settled: new Set<string>(),
      startedAt,
      endMark: markRendererActivity('pane-prewarm:' + tabId.slice(-8)),
      timeout: null as number | null,
    };
    tracker.timeout = window.setTimeout(() => {
      if (admissionTrackerRef.current === tracker) completeAdmission('component-timeout');
    }, 55_000);
    admissionTrackerRef.current = tracker;
    surfacesAwakeRef.current = true;
    heavyActivationPhaseRef.current = phase;
    // Hidden mount is precisely the work React's transition lane is for: it
    // must be interruptible by input even when the IPC/admission scheduler had
    // no way to predict that a wheel would arrive one millisecond later.
    startTransition(() => {
      setSurfacesAwake(true);
      setHeavyActivationPhase(phase);
    });
    console.warn('[Perf:PanePrewarm] phase=start tab=' + tabId.slice(-12)
      + ' pane=' + paneIndex
      + ' token=' + lease.token
      + ' requirements=' + (Array.from(requirements).join(',') || 'none'));
    if (requirements.size === 0) queueMicrotask(() => completeAdmission('no-heavy-source'));
  }, [completeAdmission, paneIndex, tabId]);

  const wakeForeground = useCallback((reason: 'focus' | 'external') => {
    const admissionState = dormantSurfaceAdmission.promote(admissionKey);
    if (!surfacesAwakeRef.current) {
      surfacesAwakeRef.current = true;
      setSurfacesAwake(true);
    }
    if (heavyActivationPhaseRef.current !== 'ready') {
      heavyActivationPhaseRef.current = 'ready';
      setHeavyActivationPhase('ready');
    }
    console.warn('[Perf:PaneWake] phase=foreground tab=' + tabId.slice(-12)
      + ' pane=' + paneIndex
      + ' reason=' + reason
      + ' admission=' + admissionState);
  }, [admissionKey, paneIndex, tabId]);

  useLayoutEffect(() => {
    const onPresentation = (event: Event) => {
      const detail = (event as CustomEvent<{
        tabId?: string;
        presented?: boolean;
        focused?: boolean;
      }>).detail;
      if (detail?.tabId !== tabId) return;
      externalPresentationRef.current = {
        presented: detail.presented === true,
        focused: detail.focused === true,
      };
      if (detail.presented === true) wakeForeground('external');
    };
    window.addEventListener(PANE_LAYER_PRESENTATION_EVENT, onPresentation);
    return () => window.removeEventListener(PANE_LAYER_PRESENTATION_EVENT, onPresentation);
  }, [tabId, wakeForeground]);

  useEffect(() => {
    if (focused) wakeForeground('focus');
  }, [focused, wakeForeground]);

  useEffect(() => {
    if (!dormant || surfacesAwakeRef.current) return undefined;
    let cancelled = false;
    let unsubscribeStartup: (() => void) | null = null;
    const enqueue = () => {
      if (cancelled || surfacesAwakeRef.current) return;
      dormantSurfaceAdmission.enqueue(admissionKey, (lease: any) => {
        if (cancelled) {
          lease.complete('unmounted-before-start');
          return;
        }
        startBackgroundPrewarm(lease);
      });
    };
    if (getStartupRestoreProgress().blocking) {
      unsubscribeStartup = subscribeStartupRestoreProgress((state: any) => {
        if (state.blocking) return;
        unsubscribeStartup?.();
        unsubscribeStartup = null;
        enqueue();
      });
    } else {
      enqueue();
    }
    return () => {
      cancelled = true;
      unsubscribeStartup?.();
      const tracker = admissionTrackerRef.current;
      if (tracker) {
        if (tracker.timeout !== null) window.clearTimeout(tracker.timeout);
        tracker.endMark?.();
        admissionTrackerRef.current = null;
      }
      dormantSurfaceAdmission.cancel(admissionKey, 'unmount');
    };
  }, [admissionKey, dormant, startBackgroundPrewarm]);

  const historyHeavyAwake = surfacesAwake && heavyActivationPhase !== 'cold';
  const timelineHeavyAwake = surfacesAwake
    && (heavyActivationPhase === 'timeline' || heavyActivationPhase === 'ready');

  // Shell/agent command state for this pane's tab — same IPC signals the
  // single-mode Workspace consumes, scoped to one tabId.
  const [isCommandRunning, setIsCommandRunning] = useState(false);
  useEffect(() => {
    // Ещё не построенное окно ни о чём не спрашивает. Построенное — следит за
    // своим процессом дальше, даже в скрытом пространстве: возврат обязан быть
    // мгновенным, а значит ничего не «доспрашивает» в кадре переключения.
    if (!surfacesAwake) return;
    let disposed = false;
    const onStarted = (_: unknown, data: { tabId?: string }) => {
      if (data?.tabId === tabId) setIsCommandRunning(true);
    };
    const onFinished = (_: unknown, data: { tabId?: string }) => {
      if (data?.tabId === tabId) setIsCommandRunning(false);
    };
    ipcRenderer.on('terminal:command-started', onStarted);
    ipcRenderer.on('terminal:command-finished', onFinished);
    ipcRenderer.invoke('terminal:getCommandState', {
      tabId,
      caller: 'SplitPaneSurface',
      expectedProcess: 'codex',
      allowProcessTreeLookup: isCodex,
    }).then((state: any) => {
      if (!disposed) setIsCommandRunning(!!state?.isRunning);
    }).catch(() => {});
    return () => {
      disposed = true;
      ipcRenderer.removeListener('terminal:command-started', onStarted);
      ipcRenderer.removeListener('terminal:command-finished', onFinished);
    };
  }, [surfacesAwake, tabId, isCodex]);

  const showOtherSurface = useCallback(() => {
    setTabTerminalIsPrimary(tabId, !resolveTabTerminalPrimary(useUIStore.getState(), tabId));
  }, [setTabTerminalIsPrimary, tabId]);

  const toggleSideTerminal = useCallback(() => {
    setSideTerminalOpen(tabId, !(useUIStore.getState().sideTerminalOpenTabs[tabId] ?? false));
  }, [setSideTerminalOpen, tabId]);

  const closeSideTerminal = useCallback(() => {
    setSideTerminalOpen(tabId, false);
  }, [setSideTerminalOpen, tabId]);

  const toggleSideHistory = useCallback(() => {
    setHistoryPanelOpen(tabId, !(useUIStore.getState().historyPanelOpenTabs[tabId] ?? false));
  }, [setHistoryPanelOpen, tabId]);

  // Открытая боковая панель-«гость» этого окна: терминал при переписке-primary
  // или переписка при терминале-primary (слот и клавиша у них общие — Cmd+]).
  //
  // Пока гость открыт, окно перестаёт обрезать его своей границей: в узком окне
  // панель фиксированной ширины вылезала за край и срезалась — «терминал не
  // видно, он выходит за границу». Обрезка существует только ради ЗАКРЫТОЙ
  // панели (та прячется сдвигом за правый край), поэтому её можно снимать
  // ровно на время, пока панель открыта: закрытая панель существует только при
  // выключенном флаге, то есть всегда под обрезкой.
  const sideOverlayOpen = historySelected ? sideTerminalOpen : (isAgentTab && sideHistoryOpen);

  const composerHostId = splitPaneComposerHostId(tabId);
  const showControlBar = tabType !== 'file';

  // Height of the transcript's docked controls (composer). The terminal keeps
  // stable PTY geometry and is shifted/cropped above this overlay.
  const [historyControlsHeight, setHistoryControlsHeight] = useState(0);
  const handleControlsHeight = useCallback((height: number) => {
    setHistoryControlsHeight((current) => (current === height ? current : height));
  }, []);

  return (
    <div
      data-split-pane-surface={tabId}
      data-split-pane-surface-mode={historySelected ? 'history' : 'terminal'}
      data-split-pane-surface-overlay={sideOverlayOpen ? '1' : '0'}
      style={{
        position: 'absolute',
        inset: 0,
        // Открытая боковая панель ЛОЖИТСЯ ПОВЕРХ СОСЕДНЕГО ОКНА — то же
        // правило, что внутри окна (гость поверх центра), перенесённое через
        // его границу. Обрезка нужна только закрытой панели (см. sideOverlayOpen).
        // Само поднятие окна над соседями делает обёртка в TerminalArea.
        //
        // Снимается только ГОРИЗОНТАЛЬ: за левый край панель выезжать должна,
        // за верхнюю кромку — нет (сцену терминала композер сдвигает вверх, и
        // без вертикальной обрезки этот сдвинутый верх вылезал над окном).
        ...(sideOverlayOpen
          ? { overflowX: 'visible' as const, overflowY: 'clip' as const }
          : { overflow: 'hidden' as const }),
        pointerEvents: 'none',
        display: 'flex',
      }}
    >
      {/* ── Left column: surfaces + composer host + control bar ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Обрезка здесь прячет ЗАКРЫТУЮ боковую панель (она сдвинута за
            правый край, как в одиночном режиме). Пока панель открыта, снимается
            только горизонтальная составляющая — панель выезжает за боковую
            границу узкого окна поверх соседнего; вертикальная остаётся, чтобы
            сдвинутая композером сцена не вылезала над верхней кромкой
            (см. sideOverlayOpen выше). */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative', ...(sideOverlayOpen ? { overflowX: 'visible' as const, overflowY: 'clip' as const } : { overflow: 'hidden' as const }) }}>
          {/* Transcript as the pane's MAIN surface. Mounted in EVERY pane that
              selected it — focus only gates global hotkeys, never content. */}
          {historySelected && historyHeavyAwake && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'auto' }}>
              <PersistentPaneHistory
                actualPresented={historySurfacePresented}
                presentationChannel={`split-pane:${tabId}:main`}
                presentationGeometryStable={presentationGeometryStable}
                tabId={tabId}
                sessionId={agentSessionId}
                cwd={cwd || projectPath}
                width={historyPanelWidth}
                notesPanelWidth={notesPanelWidth}
                isOpen
                toolType={agentToolType}
                enableClaudePtyControls
                embedded
                embeddedFill
                mainSurface
                projectId={projectId}
                onSwapPrimarySurface={showOtherSurface}
                terminalIsPrimary={false}
                terminalOpen={sideTerminalOpen}
                onToggleTerminal={toggleSideTerminal}
                onControlsHeightChange={handleControlsHeight}
                suppressGlobalHotkeys={!externalPresentationRef.current.focused}
                lifecycleStatus={paneLifecycleStatus}
                compactComposer={stacked}
                onInitialSourceSignal={handleHistoryInitialSourceSignal}
              />
            </div>
          )}

          {/* The pane's terminal. Terminal mode → fills the pane inline.
              Transcript mode → the SAME xterm docks as a side panel at THIS
              pane's right edge (kept mounted off-edge while closed). */}
          <FloatingTerminalFrame
            tabId={tabId}
            tabName={tabName}
            floating={historySelected}
            open={!historySelected || sideTerminalOpen}
            bottomInset={historyControlsHeight}
            // Panes are already narrow, so a pinned column here would leave the
            // centre unusable; the pane's side panels stay overlays.
            pinned={false}
            onClose={closeSideTerminal}
          >
            {children}
          </FloatingTerminalFrame>

          {/* Terminal mode: side transcript slice at the pane's right edge.
              Stays mounted while closed — it owns the docked composer below.
              `bottom` is the measured height of that composer, so the panel
              stops ABOVE the input instead of covering it — the side terminal
              keeps its PTY geometry and shifts by the same measured inset
              and the same number, so the two cannot disagree. */}
          {isAgentTab && !historySelected && historyHeavyAwake && (
            <div
              data-split-pane-side-history
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                bottom: Math.max(0, historyControlsHeight),
                width: historyPanelWidth,
                // Ширину НЕ ужимаем под узкое окно: открытая панель выезжает
                // за его границу поверх соседа — как боковой терминал.
                zIndex: 130,
                pointerEvents: sideHistoryOpen ? 'auto' : 'none',
              }}
            >
              <PersistentPaneHistory
                actualPresented={historySurfacePresented && sideHistoryOpen}
                presentationChannel={`split-pane:${tabId}:side`}
                presentationGeometryStable={presentationGeometryStable}
                tabId={tabId}
                sessionId={agentSessionId}
                cwd={cwd || projectPath}
                width={historyPanelWidth}
                notesPanelWidth={notesPanelWidth}
                isOpen={sideHistoryOpen}
                toolType={agentToolType}
                enableClaudePtyControls
                agentSidePanel
                composerPortalHostId={composerHostId}
                projectId={projectId}
                onSwapPrimarySurface={showOtherSurface}
                terminalIsPrimary
                terminalOpen={sideHistoryOpen}
                onToggleTerminal={toggleSideHistory}
                onControlsHeightChange={handleControlsHeight}
                suppressGlobalHotkeys={!externalPresentationRef.current.focused}
                lifecycleStatus={paneLifecycleStatus}
                compactComposer={stacked}
                onInitialSourceSignal={handleHistoryInitialSourceSignal}
              />
            </div>
          )}

          {/* Run after strip host — the pane's service layer. Above BOTH its
              surfaces и выше его боковых окон (у тех 130), никогда не гасится и
              не прячется переключателем режима.

              Полоска принадлежит окну целиком, а боковая панель — временный
              гость поверх его центра, вызываемый одной клавишей. Гость не может
              закрывать собой постоянный орган управления: полоска перестала
              отходить в сторону при его открытии, и на слое ниже это означало
              бы не «стоит на месте», а «спряталась под ним». То же правило и
              тем же числом действует в одиночном режиме
              (Workspace.tsx::promptQueuePortalHostId) — раскладки разные, а
              ответ на вопрос «кто кого закрывает» один.

              `bottom` is the measured height of this pane's docked input, so
              the strip stops ABOVE the composer instead of overlapping it. The
              same number moves the pane's terminal upward, so the two cannot
              disagree. It is a sibling of the terminal stage on purpose: put
              inside it, the strip would ride that upward shift and drift off
              the top edge (see FloatingTerminalFrame translateY). */}
          <div
            id={splitPaneQueueHostId(tabId)}
            data-split-pane-queue-host
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: Math.max(0, historyControlsHeight),
              zIndex: 140,
              pointerEvents: 'none',
            }}
          />

          {surfacesAwake && <TabTaskPlanPanel
            tabId={tabId}
            projectPath={projectPath}
            inputSurface={isAgentTab && (historySelected || sideHistoryOpen)
              ? 'history'
              : tabType === 'claude-sdk' ? 'sdk' : 'terminal'}
            commandType={commandType as CommandType | null}
          />}

          {/* Keep xterm rows stable while the portalled composer grows. The
              host overlays the fixed viewport; the inline terminal is shifted
              upward and clipped instead of being fitted to a shorter box. */}
          {isAgentTab && !historySelected && (
            <div
              id={composerHostId}
              data-split-pane-composer-host
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 140,
                pointerEvents: 'auto',
              }}
            />
          )}
        </div>

        {showControlBar && surfacesAwake && (
          // overflowX убран намеренно: он давал горизонтальный скролл вместо
          // переноса, и в узкой панели бар оставался одной строкой со съехавшими
          // друг на друга кнопками. Бар теперь сам переносит блоки в две строки
          // по измеренной ширине (см. ClaudeControlBar / controlBarWrap).
          <div style={{ pointerEvents: 'auto', flexShrink: 0, minWidth: 0 }}>
            <ClaudeControlBar
              tabId={tabId}
              projectId={projectId}
              historyIsPrimary={isAgentTab && (historySelected || sideHistoryOpen)}
              claudeSessionId={claudeSessionId || null}
              geminiSessionId={geminiSessionId || null}
              codexSessionId={codexSessionId || null}
              commandType={commandType}
              isCommandRunning={isCommandRunning}
              projectPath={projectPath}
            />
          </div>
        )}
      </div>

      {/* ── The pane's own Timeline column at its right edge ── */}
      {showTimeline && timelineHeavyAwake && (
        <div style={{ pointerEvents: 'auto', height: '100%', flexShrink: 0, display: 'flex' }}>
          <PersistentPaneTimeline
            tabId={tabId}
            sessionId={timelineSessionId}
            cwd={cwd || projectPath}
            isActive={isCommandRunning}
            isTurnBusy={aiBusy}
            // Visibility belongs to this exact retained pane, not merely to
            // the app's workspace view. A dormant Timeline still performs its
            // one admitted prewarm, then coalesces invalidations until shown.
            initialPresented={historySurfacePresented}
            isOpen
            toolType={timelineToolType}
            pinned={timelinePinned}
            historySurfaceVisible={historySelected}
            backgroundPrewarmAdmitted={heavyActivationPhase === 'timeline' && !historySurfacePresented}
            onInitialSourceSignal={handleTimelineInitialSourceSignal}
          />
        </div>
      )}
    </div>
  );
}
