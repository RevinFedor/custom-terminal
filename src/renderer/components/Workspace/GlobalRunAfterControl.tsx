import { usePointerGesture } from '../../hooks/usePointerGesture';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Ban,
  Check,
  Eye,
  EyeOff,
  GitBranch,
  Percent,
  PanelRightDashed,
  Power,
} from 'lucide-react';
import {
  hasPendingPromptQueueContinuation,
  isQueuedPromptEnabled,
  usePromptQueueStore,
  type TabQueue,
} from '../../store/usePromptQueueStore';
import { useAutoCompactStore } from '../../store/useAutoCompactStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import {
  useAutomationInventory,
  useAutomationBusyTabs,
  type AutomationTab,
} from '../../hooks/useAutomationInventory';
import { cancelPendingAutoCompact, requestAutoCompactNow } from '../../hooks/usePromptQueueRunner';
import { autoCompactIncludesTarget, UNPLACED_AUTOMATION_WORKFLOW } from '../../utils/autoCompactPolicy.mjs';
import { summarizeRunningAutoCompacts } from '../../utils/autoCompactActivityPresentation.mjs';
import WorkflowChip from './WorkflowChip';
import { getHistoryAgentRuntime } from '../../utils/historyAgentRuntimes';
import { pointInHoverCluster, pointInRect } from '../../utils/hoverBridge.mjs';
import { captureQueueHoverReturn, createHoverReturnGate } from '../../utils/hoverReturnGate.mjs';
import { collectQueueRelations, layoutRunAfterCards, retainRunAfterGroups, RUN_AFTER_GROUP_INSET, RUN_AFTER_DEPTH_INSET } from '../../utils/runAfterDependencyLayout.mjs';
import { requestTabPrimaryInputFocus } from '../../utils/tabPrimaryInputFocus';
import { retainPanelPosition, scrollMovesAnchor } from '../../utils/anchoredPanelPosition.mjs';
import { PromptQueueOverlay } from './PromptQueueOverlay';
import { TabPaneMap } from './PaneMap';
import TabCard from './TabCard';
import { RunAfterStatusIcon } from './RunAfterTabPicker';

const PANEL_MARGIN = 8;
// Page controls straddle the top frame by 14px. The full gap therefore owns
// that outside half instead of letting it overlap the navigation row.
const PANEL_GAP = 17;
const PANEL_MIN_W = 240;
const PANEL_DEFAULT_W = 760;
const PANEL_DEFAULT_H = 600;
const GLOBAL_PANEL_SIZE_KEY = 'noted-terminal-global-run-after-size';

type GlobalPanelSize = { width: number; height: number; resizeEnabled: boolean };
type QueueCloseRef = { current: (reason?: 'outside') => boolean };
type QueueLayoutMemory = {
  primary: ReturnType<typeof retainRunAfterGroups> | null;
  secondary: ReturnType<typeof retainRunAfterGroups> | null;
};

function queueHoverSatelliteRects(root: HTMLElement | null): DOMRect[] {
  const owners = new Set(Array.from(root?.querySelectorAll<HTMLElement>(
    '[data-prompt-queue-hover-owner]',
  ) || []).map(element => element.dataset.promptQueueHoverOwner));
  if (!owners.size) return [];
  // Each inline queue owns its own portals; viewport backdrops are not territory.
  return Array.from(document.querySelectorAll<HTMLElement>('[data-run-after-hover-owner]'))
    .filter(element => owners.has(element.dataset.runAfterHoverOwner))
    .map(element => element.getBoundingClientRect());
}

const button: CSSProperties = {
  border: '1px solid #383838',
  borderRadius: 6,
  background: '#202020',
  color: '#bbb',
  cursor: 'pointer',
  padding: '4px 8px',
  fontSize: 12,
  fontFamily: 'inherit',
};

const clamp = (value: number, min: number, max: number) => (
  Math.max(Math.min(min, max), Math.min(Math.max(min, max), value))
);

function loadPanelSize(): GlobalPanelSize {
  try {
    const parsed = JSON.parse(localStorage.getItem(GLOBAL_PANEL_SIZE_KEY) || '{}');
    return {
      width: Number.isFinite(parsed.width) ? Math.max(PANEL_MIN_W, parsed.width) : PANEL_DEFAULT_W,
      height: Number.isFinite(parsed.height) ? Math.max(170, parsed.height) : PANEL_DEFAULT_H,
      // Old fixed dimensions become limits. Only explicit resize mode exposes
      // the reserved canvas; ordinary viewing always trims to the content.
      resizeEnabled: parsed.resizeEnabled === true,
    };
  } catch {
    return { width: PANEL_DEFAULT_W, height: PANEL_DEFAULT_H, resizeEnabled: false };
  }
}

function globalRunAfterMinimumWidth(panel: HTMLElement | null, pages: HTMLElement | null) {
  const legend = (pages?.getBoundingClientRect().width || PANEL_MIN_W - 24) + 24;
  const controls = Array.from(panel?.querySelectorAll<HTMLElement>('[data-prompt-queue-edge-controls]') || []);
  return Math.ceil(Math.max(legend, ...controls.map(control => {
    const node = control.closest<HTMLElement>('[data-global-run-after-node]');
    const canvas = control.closest<HTMLElement>('[data-global-run-after-graph]');
    if (!node || !canvas || !panel) return 0;
    const inset = panel.getBoundingClientRect().width - canvas.clientWidth;
    const indent = RUN_AFTER_GROUP_INSET + (Number(node.dataset.globalRunAfterDepth) || 0) * RUN_AFTER_DEPTH_INSET;
    return control.getBoundingClientRect().right - node.getBoundingClientRect().left + indent + inset + 1;
  })));
}

function queueIsConfigured(queue: TabQueue | undefined): boolean {
  return !!queue && (
    queue.items.length > 0
    || queue.postPromptEnabled
    || queue.loopPromptEnabled
    || queue.firstDelaySeconds > 0
    || !!queue.runAfterTabId
  );
}

function QueueTabNode({ tab, queue, busy, awaited }: {
  tab: AutomationTab;
  queue?: TabQueue;
  busy: boolean;
  awaited: boolean;
}) {
  const active = useWorkspaceStore(state => state.activeProjectId === tab.projectId
    && state.openProjects.get(tab.projectId)?.activeTabId === tab.id);
  const hasCondition = queue?.items.some(item => isQueuedPromptEnabled(item) && item.condition);
  const navigate = () => {
    useWorkspaceStore.getState().placeTab(tab.projectId, tab.id);
    useUIStore.getState().setActiveArea('workspace');
    requestTabPrimaryInputFocus(tab.id, 'global-run-after-tab');
  };
  const placeHere = (event: React.MouseEvent) => {
    const cmdClick = event.button === 0 && event.metaKey
      && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (event.button !== 1 && !cmdClick) return;
    event.preventDefault(); event.stopPropagation();
    useWorkspaceStore.getState().placeTab(tab.projectId, tab.id, { mode: 'add-here' });
    useUIStore.getState().setActiveArea('workspace');
    requestTabPrimaryInputFocus(tab.id, 'global-run-after-add-here');
  };
  return <div data-global-run-after-heading={tab.id}
    style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4, width: 'max-content', maxWidth: '100%', minWidth: 0, zIndex: 3 }}>
    <span data-global-run-after-project-icon={tab.projectId} title={tab.projectName} aria-hidden
      style={{ width: 12, flex: '0 0 12px', display: 'grid', placeItems: 'center', marginRight: 2 }}>
      {tab.projectIcon ? <img src={tab.projectIcon} alt="" draggable={false}
        style={{ width: 12, height: 12, borderRadius: 2, objectFit: 'cover' }} />
        : <span style={{ width: 12, height: 12, borderRadius: 2, border: '1px dashed #949cae' }} />}
    </span>
    {hasCondition && <span data-global-run-after-condition-mark title="В очереди есть условие по контексту"
      style={{ position: 'absolute', top: -5, left: 0, color: '#a78bfa', lineHeight: 1 }}>
      <Percent size={9} />
    </span>}
    <TabCard as="button" projectId={tab.projectId} tabId={tab.id} active={active} reserveSignalSpace showTaskMarkers={false}
      data-global-run-after-tab-chip={tab.id}
      activityOverride={{ hasProcess: false, busy, inheritedBusy: false }}
      style={{ flex: '0 1 auto', maxWidth: 280 }}
      onClick={(event) => {
        if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) placeHere(event);
        else navigate();
      }}
      onAuxClick={placeHere}
      title={tab.name + ' · ' + tab.projectName + '\nКлик — перейти; Cmd+клик или средний клик — поместить в текущее окно'}
      trailingActions={<>
        {awaited && <span data-global-run-after-awaited={tab.id} style={{ display: 'inline-flex', flexShrink: 0 }}>
          <RunAfterStatusIcon status="waiting" color="#a78bfa" title="Эту вкладку ожидает шаг Run After" />
        </span>}
        <TabPaneMap projectId={tab.projectId} tabId={tab.id} />
      </>} />
  </div>;
}

function QueueBlock({ tab, queue, busy, awaited, register, onRewindTargetModeChange, onHoverGestureChange, graphTargets }: {
  tab: AutomationTab; queue: TabQueue; busy: boolean; graphTargets: ReadonlySet<string>;
  awaited: boolean;
  register: (tabId: string, ref: QueueCloseRef | null) => void;
  onRewindTargetModeChange: (active: boolean) => void;
  onHoverGestureChange: (active: boolean, point: { clientX: number; clientY: number } | null) => void;
}) {
  const closeRef = useRef<(reason?: 'outside') => boolean>(() => true);
  useLayoutEffect(() => {
    register(tab.id, closeRef);
    return () => register(tab.id, null);
  }, [register, tab.id]);
  return <div data-global-run-after-node={tab.id}
    style={{ position: 'absolute', top: 0, left: 0, width: 'max-content',
      maxWidth: 'var(--ra-card-max-width, 320px)', minWidth: 0 }}>
    <QueueTabNode tab={tab} queue={queue} busy={busy} awaited={awaited} />
    <div data-global-run-after-inline-editor={tab.id}
      style={{ position: 'relative', zIndex: 4, width: 'max-content', maxWidth: 'calc(100% - 18px)', marginLeft: 18, paddingTop: 8 }}>
      <PromptQueueOverlay tabId={tab.id} sessionType={tab.provider} agentBusy={busy} inputSurface="history"
        embedded overview graphTargets={graphTargets} embeddedWidth={300} beforeCloseRef={closeRef}
        onRewindTargetModeChange={onRewindTargetModeChange} onHoverGestureChange={onHoverGestureChange} />
    </div>
  </div>;
}

function ChoiceChip({ selected, disabled, onClick, children, title }: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button type="button" className="gra-choice" aria-pressed={selected} disabled={disabled} onClick={onClick} title={title}
      style={{ ...button, height: 25, padding: '0 7px', display: 'inline-flex', alignItems: 'center', gap: 4,
        color: selected ? '#e7d8c5' : '#999', borderColor: selected ? '#806044' : '#373737',
        background: selected ? 'rgba(147,88,42,0.18)' : '#1e1e1e', opacity: disabled ? 0.52 : 1,
        cursor: disabled ? 'default' : 'pointer' }}>
      <span aria-hidden style={{ width: 11, height: 11, display: 'grid', placeItems: 'center' }}>
        {selected && <Check size={10} strokeWidth={2.5} />}
      </span>
      {children}
    </button>
  );
}

function AutoCompactRunningIndicator({ count, scope }: { count: number; scope: string }) {
  const label = count === 1 ? 'Выполняется 1 автокомпакт' : `Выполняется автокомпактов: ${count}`;
  return (
    <span role="status" aria-label={label} title={label} data-auto-compact-running-count={count}
      data-auto-compact-running-scope={scope}
      style={{ position: 'relative', width: 17, height: 17, flex: '0 0 17px', display: 'inline-grid',
        placeItems: 'center', color: '#ddd6fe', fontSize: 8, lineHeight: 1, fontWeight: 650,
        fontVariantNumeric: 'tabular-nums' }}>
      <span aria-hidden className="gra-auto-compact-spinner" style={{ position: 'absolute', inset: 0,
        border: '1px solid rgba(167,139,250,0.28)', borderTopColor: '#c4b5fd', borderRightColor: '#8b5cf6',
        borderRadius: '50%', boxSizing: 'border-box' }} />
      <span aria-hidden>{count}</span>
    </span>
  );
}

type Candidate = { tab: AutomationTab; percent: number; stopped: boolean };

function AutoCompactPage({ inventory, busy, widthLimit, resizeEnabled, onContentWidth }: {
  inventory: ReturnType<typeof useAutomationInventory>;
  busy: Map<string, boolean>;
  widthLimit: number;
  resizeEnabled: boolean;
  onContentWidth: (width: number) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const container = content.parentElement!;
    const panel = content.closest<HTMLElement>('[data-global-run-after-panel]')!;
    const measure = () => {
      const inset = panel.getBoundingClientRect().width - container.clientWidth;
      const maxWidth = Math.max(1, resizeEnabled ? container.clientWidth : widthLimit - inset) + 'px';
      if (content.style.maxWidth !== maxWidth) content.style.maxWidth = maxWidth;
      onContentWidth(content.getBoundingClientRect().width + inset);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content); observer.observe(container);
    return () => observer.disconnect();
  }, [widthLimit, resizeEnabled, onContentWidth]);
  const policy = useAutoCompactStore((state) => state.policy);
  const hydrated = useAutoCompactStore((state) => state.hydrated);
  const activities = useAutoCompactStore((state) => state.activities);
  const running = summarizeRunningAutoCompacts(activities, inventory.tabs);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [showExceptions, setShowExceptions] = useState(false);
  const cancelled = useRef(false);
  const update = useAutoCompactStore.getState().updatePolicy;

  useEffect(() => {
    if (!hydrated || policy.scopeInitialized) return;
    const current = useWorkspaceStore.getState().activeSpaceId;
    update({ workflowIds: current ? [current] : [], scopeInitialized: true });
  }, [hydrated, policy.scopeInitialized, update]);

  const selectedWorkflowNames = inventory.groups
    .filter((group: any) => group.id !== UNPLACED_AUTOMATION_WORKFLOW && policy.workflowIds.includes(group.id))
    .map((group: any) => group.name);
  const scopeLabel = policy.allWorkflows ? 'Все workflow' : selectedWorkflowNames.join(', ');
  const scopeText = [scopeLabel, policy.includeUnplaced ? 'Без workflow' : ''].filter(Boolean).join(' + ');

  const inspect = async () => {
    setLoading(true); setError(''); setSelected([]); setResults({});
    try {
      const found: Candidate[] = [];
      const tabs = inventory.tabs.filter((tab) => tab.sessionId && !busy.get(tab.id)
        && autoCompactIncludesTarget(policy, { ...tab, tabId: tab.id }));
      for (let index = 0; index < tabs.length; index += 6) {
        const batch = await Promise.all(tabs.slice(index, index + 6).map(async (tab) => {
          const { ipcRenderer } = window.require('electron');
          const [context, presence] = await Promise.all([
            ipcRenderer.invoke('tab:get-context-pct', { tabId: tab.id }),
            getHistoryAgentRuntime(tab.provider).getPresence(tab.id, tab.projectId),
          ]);
          if (typeof context?.pct !== 'number' || context.pct < policy.percent || presence.isBusy) return null;
          if (!['active', 'inactive'].includes(presence.status)) return null;
          return { tab, percent: context.pct, stopped: presence.status === 'inactive' };
        }));
        found.push(...batch.filter((candidate): candidate is Candidate => candidate !== null));
      }
      setCandidates(found);
    } catch (reason) {
      setError('Не удалось проверить сессии: ' + String(reason));
    } finally { setLoading(false); }
  };

  const apply = async () => {
    if (applying) return;
    cancelled.current = false; setApplying(true);
    try {
      for (const id of selected) {
        if (cancelled.current) break;
        const candidate = candidates?.find((item) => item.tab.id === id);
        if (!candidate) continue;
        const result = await requestAutoCompactNow(id, candidate.stopped);
        setResults((previous) => ({ ...previous, [id]: result.completed ? 'Готово' : result.error || 'Пропущено: условие изменилось' }));
      }
    } finally { setApplying(false); }
  };

  return (
    <div ref={contentRef} data-global-auto-compact style={{ padding: '10px 2px 4px', width: 'max-content',
      maxWidth: Math.max(1, widthLimit - 28), boxSizing: 'border-box' }}>
      <div style={{ position: 'relative', border: '1px solid #343434', borderRadius: 8, padding: '19px 10px 10px' }}>
        <div style={{ position: 'absolute', top: 0, left: 10, transform: 'translateY(-50%)', display: 'inline-flex',
          alignItems: 'center', gap: 4, padding: '0 4px', background: '#181818' }}>
          <button type="button" className="gra-control" disabled={!hydrated || !scopeText} aria-pressed={policy.enabled}
            onClick={() => update({ enabled: !policy.enabled })} title={scopeText ? `Область: ${scopeText}` : 'Сначала выберите workflow'}
            style={{ ...button, height: 25, padding: '0 8px', display: 'inline-flex', alignItems: 'center', gap: 5,
              color: policy.enabled ? '#e7bb8d' : '#999', borderColor: policy.enabled ? '#8a5f39' : '#383838',
              background: policy.enabled ? 'rgba(147,88,42,0.20)' : '#1e1e1e', opacity: !hydrated || !scopeText ? 0.55 : 1 }}>
            <Power size={12} /> Автокомпакт
          </button>
          <label title="Порог использованного контекста" style={{ height: 25, display: 'inline-flex', alignItems: 'center',
            gap: 3, padding: '0 6px', border: '1px solid #383838', borderRadius: 6, background: '#1e1e1e',
            color: '#a9d8ba', boxSizing: 'border-box' }}>
            ≥
            <input aria-label="Порог автокомпакта" className="gra-number" type="number" min={1} max={100} value={policy.percent}
              disabled={!hydrated} onChange={(event) => update({ percent: Number(event.target.value) })}
              style={{ width: 30, padding: 0, border: 0, outline: 0, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'right' }} />%
          </label>
        </div>

        <div style={{ color: '#8c8c92', fontSize: 10.5, marginBottom: 7 }}>
          После новых завершённых ответов · область: {scopeText || 'не выбрана'}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          <ChoiceChip selected={policy.allWorkflows} disabled={!hydrated} onClick={() => update({ allWorkflows: !policy.allWorkflows })}>
            Все workflow
          </ChoiceChip>
          {inventory.groups.map((group: any) => {
            const unplaced = group.id === UNPLACED_AUTOMATION_WORKFLOW;
            const selectedGroup = unplaced ? policy.includeUnplaced : policy.allWorkflows || policy.workflowIds.includes(group.id);
            const runningCount = running.workflowCounts.get(group.id) || 0;
            return (
              <WorkflowChip key={group.id} workflowId={group.id} label={group.name} icon={group.icon}
                data-auto-compact-workflow-chip={group.id} unplaced={unplaced}
                selected={selectedGroup} disabled={!hydrated || (!unplaced && policy.allWorkflows)}
                title={group.projectNames.length ? group.projectNames.join(', ') : undefined}
                onClick={() => {
                  if (unplaced) update({ includeUnplaced: !policy.includeUnplaced });
                  else update({ workflowIds: policy.workflowIds.includes(group.id)
                    ? policy.workflowIds.filter((id: string) => id !== group.id)
                    : [...policy.workflowIds, group.id] });
                }}>
                {selectedGroup && <Check aria-hidden size={11} strokeWidth={2.5} style={{ flexShrink: 0 }} />}
                {runningCount > 0 && <AutoCompactRunningIndicator count={runningCount} scope={group.id} />}
              </WorkflowChip>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 9 }}>
        <button type="button" className="gra-control" aria-expanded={showExceptions} onClick={() => setShowExceptions(!showExceptions)}
          style={{ ...button, height: 27, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Ban size={12} /> Исключения · {policy.excludedTabIds.length}
        </button>
        <button type="button" className="gra-control" disabled={loading || applying || !scopeText} onClick={inspect}
          style={{ ...button, height: 27, opacity: loading || applying || !scopeText ? 0.55 : 1 }}>
          {loading ? 'Проверяем…' : 'К уже простаивающим…'}
        </button>
      </div>

      {showExceptions && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
        {inventory.tabs.map((tab) => {
          const excluded = policy.excludedTabIds.includes(tab.id);
          return <ChoiceChip key={tab.id} selected={excluded} title={tab.projectName}
            onClick={() => useAutoCompactStore.getState().setExcluded(tab.id, !excluded)}>{tab.name}</ChoiceChip>;
        })}
      </div>}

      {!!Object.keys(activities).length && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 7 }}>
        {Object.entries(activities).map(([tabId, activity]) => <span key={tabId}
          style={{ ...button, cursor: 'default', color: activity.phase === 'error' ? '#d8a174' : '#c1a487' }}>
          {inventory.tabs.find((tab) => tab.id === tabId)?.name || tabId} · {activity.message}
        </span>)}
      </div>}
      {error && <div style={{ color: '#d8a174', marginTop: 7, fontSize: 11 }}>{error}</div>}

      {candidates && <div style={{ marginTop: 9, borderTop: '1px solid #303030', paddingTop: 8 }}>
        {!candidates.length && <div style={{ color: '#777', fontSize: 11 }}>Нет подходящих простаивающих сессий</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {candidates.map(({ tab, percent, stopped }) => {
            const isSelected = selected.includes(tab.id);
            return <ChoiceChip key={tab.id} selected={isSelected} disabled={applying}
              title={`${tab.projectName} · ${Math.round(percent)}%${stopped ? ' · остановлена, потребуется запуск' : ''}${results[tab.id] ? ` · ${results[tab.id]}` : ''}`}
              onClick={() => setSelected((ids) => isSelected ? ids.filter((id) => id !== tab.id) : [...ids, tab.id])}>
              {tab.name} · {Math.round(percent)}%
            </ChoiceChip>;
          })}
        </div>
        {!!selected.length && <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
          <button type="button" className="gra-control" disabled={applying} onClick={apply} style={button}>Сжать выбранные · {selected.length}</button>
          {applying && <button type="button" className="gra-control" onClick={() => {
            cancelled.current = true;
            for (const id of selected) cancelPendingAutoCompact(id);
          }} style={button}>Отменить ожидание</button>}
        </div>}
      </div>}
    </div>
  );
}

function QueueOverview({ inventory, queues, busy, beforeCloseRef, layoutMemoryRef, widthLimit, resizeEnabled, onContentWidth, onRewindTargetModeChange, onHoverGestureChange }: {
  inventory: ReturnType<typeof useAutomationInventory>;
  queues: Map<string, TabQueue>; busy: Map<string, boolean>; beforeCloseRef: QueueCloseRef;
  layoutMemoryRef: { current: QueueLayoutMemory };
  widthLimit: number;
  resizeEnabled: boolean;
  onContentWidth: (width: number) => void;
  onRewindTargetModeChange: (active: boolean) => void;
  onHoverGestureChange: (active: boolean, point: { clientX: number; clientY: number } | null) => void;
}) {
  const [showDisabled, setShowDisabled] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null), svgRef = useRef<SVGSVGElement>(null);
  const shelfRef = useRef<HTMLDivElement>(null);
  const markerId = useId().replace(/:/g, '');
  const editors = useRef(new Map<string, QueueCloseRef>());
  const register = useCallback((tabId: string, ref: QueueCloseRef | null) => {
    if (ref) editors.current.set(tabId, ref); else editors.current.delete(tabId);
  }, []);
  useLayoutEffect(() => {
    const close = (reason?: 'outside') => {
      let allowed = true;
      for (const ref of editors.current.values()) if (!ref.current(reason)) allowed = false;
      return allowed;
    };
    beforeCloseRef.current = close;
    return () => { if (beforeCloseRef.current === close) beforeCloseRef.current = () => true; };
  }, [beforeCloseRef]);
  const known = new Set(inventory.tabs.map(tab => tab.id));
  const edges = inventory.tabs.flatMap(tab => collectQueueRelations(tab.id, queues.get(tab.id)));
  const shelves = useRef(new Map<string, boolean>());
  const primary = new Set(inventory.tabs.filter(tab => {
    const queue = queues.get(tab.id);
    return shelves.current.get(tab.id) === false || (queue && hasPendingPromptQueueContinuation(queue));
  }).map(tab => tab.id));
  const expand = (ids: Set<string>) => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) if (ids.has(edge.source) && known.has(edge.target) && !ids.has(edge.target)) {
        ids.add(edge.target); changed = true;
      }
    }
  };
  expand(primary);
  for (const id of primary) shelves.current.set(id, false);
  const disabled = new Set(inventory.tabs.filter(tab => !primary.has(tab.id)
    && (queueIsConfigured(queues.get(tab.id)) || shelves.current.get(tab.id) === true)).map(tab => tab.id));
  for (const id of disabled) if (!shelves.current.has(id)) shelves.current.set(id, true);
  const secondary = new Set(showDisabled ? disabled : []);
  expand(secondary);
  for (const id of primary) secondary.delete(id);
  const visible = inventory.tabs.filter(tab => primary.has(tab.id) || secondary.has(tab.id));
  const graphTargets = new Set(visible.map(tab => tab.id));
  const visibleEdges = edges.filter(edge => graphTargets.has(edge.source) && graphTargets.has(edge.target));
  const awaitedTargets = new Set(visibleEdges.filter(edge => edge.enabled).map(edge => edge.target));
  const geometryKey = JSON.stringify({ primary: [...primary], secondary: [...secondary], disabled: [...disabled],
    edges: visibleEdges.map(edge => [edge.source, edge.target, edge.itemId, edge.kind]),
    // Reordering a non-dependent step can move an edge's origin without changing
    // node height or the edge list. Item order is part of geometry, not topology.
    items: visible.map(tab => [tab.id, queues.get(tab.id)?.items.map(item => [item.id, item.enabled, item.trigger?.kind, item.condition?.kind])]),
  });
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const panel = canvas.closest<HTMLElement>('[data-global-run-after-panel]');
      const inset = (panel?.getBoundingClientRect().width || canvas.clientWidth) - canvas.clientWidth;
      // Packing uses the saved limit, not the trimmed frame. Otherwise fitting
      // the frame feeds back into packing and prevents later content growth.
      const availableWidth = Math.max(1, resizeEnabled ? canvas.clientWidth : widthLimit - inset);
      canvas.style.setProperty('--ra-layout-width', availableWidth + 'px');
      const maximum = Math.max(180, Math.min(320, availableWidth - 32));
      const cssWidth = maximum + 'px';
      if (canvas.style.getPropertyValue('--ra-card-max-width') !== cssWidth) canvas.style.setProperty('--ra-card-max-width', cssWidth);
      const elements = Array.from(canvas.querySelectorAll<HTMLElement>('[data-global-run-after-node]'));
      const snapshots = elements.map(element => {
        const rect = element.getBoundingClientRect();
        const header = element.querySelector<HTMLElement>('[data-global-run-after-heading]')!;
        const chip = element.querySelector<HTMLElement>('[data-global-run-after-tab-chip]')!;
        const editor = element.querySelector<HTMLElement>('[data-global-run-after-inline-editor]')!;
        const controls = editor.querySelector<HTMLElement>('[data-prompt-queue-edge-controls]')!;
        const headerRect = header.getBoundingClientRect(), chipRect = chip.getBoundingClientRect(), controlsRect = controls.getBoundingClientRect();
        const stepAnchors = new Map<string, { x: number; y: number }>(Array.from(element.querySelectorAll<HTMLElement>('[data-prompt-queue-item]')).map(step => {
          const bounds = step.getBoundingClientRect();
          return [step.dataset.promptQueueItem!, { x: bounds.left - rect.left - 3, y: bounds.top - rect.top + bounds.height / 2 }];
        }));
        const loopRect = element.querySelector<HTMLElement>('[data-prompt-queue-loop-toggle]')?.getBoundingClientRect() || controlsRect;
        stepAnchors.set('queue-target', { x: loopRect.left - rect.left - 3, y: loopRect.top - rect.top + loopRect.height / 2 });
        return { id: element.dataset.globalRunAfterNode!, element, editor, width: rect.width, height: rect.height,
          stepAnchors,
          headerY: headerRect.top - rect.top + headerRect.height / 2,
          // The whole header starts with the project icon. No path crosses it.
          headerX: headerRect.left - rect.left,
          overlapAdjustment: chipRect.bottom - 2 - controlsRect.top };
      });
      const sizes = snapshots.map(({ id, width, height }) => ({ id, width, height }));
      layoutMemoryRef.current.primary = retainRunAfterGroups(layoutMemoryRef.current.primary, { nodeIds: [...primary], edges: visibleEdges });
      const main = layoutRunAfterCards({ nodeIds: [...primary], edges: visibleEdges, sizes, availableWidth, groups: layoutMemoryRef.current.primary });
      const shelfHeight = shelfRef.current?.getBoundingClientRect().height || 0;
      const shelfTop = main.height ? main.height + 12 : 26;
      const secondaryTop = shelfTop + (shelfHeight ? shelfHeight + 10 : 0);
      layoutMemoryRef.current.secondary = retainRunAfterGroups(layoutMemoryRef.current.secondary, { nodeIds: [...secondary], edges: visibleEdges });
      const extra = layoutRunAfterCards({ nodeIds: [...secondary], edges: visibleEdges, sizes, availableWidth, groups: layoutMemoryRef.current.secondary });
      const positions = new Map([...main.nodes, ...extra.nodes.map(node => ({ ...node, y: node.y + secondaryTop }))].map(node => [node.id, node]));
      for (const item of snapshots) {
        const position = positions.get(item.id);
        if (!position) continue;
        const transform = `translate(${position.x}px, ${position.y}px)`;
        if (item.element.style.transform !== transform) item.element.style.transform = transform;
        item.element.dataset.globalRunAfterDepth = String(position.depth);
        item.element.dataset.globalRunAfterLane = String(position.lane);
        // Only a scoped margin changes; the shared TabCard's padding remains its owner's.
        if (Math.abs(item.overlapAdjustment) > 0.1) {
          item.editor.style.marginTop = (parseFloat(item.editor.style.marginTop || '0') + item.overlapAdjustment) + 'px';
        }
      }
      const shelfTransform = `translate(0px, ${shelfTop}px)`;
      if (shelfRef.current && shelfRef.current.style.transform !== shelfTransform) shelfRef.current.style.transform = shelfTransform;
      const totalHeight = extra.nodes.length ? secondaryTop + extra.height : shelfHeight ? shelfTop + shelfHeight : main.height;
      const emptyBounds = canvas.querySelector('[data-global-run-after-empty]')?.getBoundingClientRect();
      const height = Math.max(totalHeight, emptyBounds?.height || 0) + 'px';
      if (canvas.style.height !== height) canvas.style.height = height;
      const shelfWidth = shelfRef.current?.querySelector('button')?.getBoundingClientRect().width || 0;
      const emptyWidth = emptyBounds?.width || 0;
      onContentWidth(Math.max(main.width, extra.width, shelfWidth, emptyWidth + 8) + inset);
      const headerMap = new Map(snapshots.map(item => [item.id, item]));
      for (const path of svgRef.current?.querySelectorAll<SVGPathElement>('[data-run-after-edge-item]') || []) {
        const source = positions.get(path.dataset.runAfterEdgeOwner!), target = positions.get(path.dataset.runAfterEdgeTarget!);
        const sourceHeader = headerMap.get(path.dataset.runAfterEdgeOwner!), targetHeader = headerMap.get(path.dataset.runAfterEdgeTarget!);
        if (!source || !target || !sourceHeader || !targetHeader) continue;
        const origin = sourceHeader.stepAnchors.get(path.dataset.runAfterEdgeItem!);
        if (!origin) { path.setAttribute('d', ''); continue; }
        const sx = source.x + origin.x, sy = source.y + origin.y;
        const tx = target.x + targetHeader.headerX - 3, ty = target.y + targetHeader.headerY;
        const lane = Math.min(source.lane, target.lane), r = 4, down = ty >= sy ? 1 : -1;
        const d = `M ${sx} ${sy} H ${lane + r} Q ${lane} ${sy} ${lane} ${sy + down * r} V ${ty - down * r} Q ${lane} ${ty} ${lane + r} ${ty} H ${tx}`;
        if (path.getAttribute('d') !== d) path.setAttribute('d', d);
        const dot = path.nextElementSibling;
        dot?.setAttribute('cx', String(sx)); dot?.setAttribute('cy', String(sy));
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(canvas);
    canvas.querySelectorAll<HTMLElement>('[data-global-run-after-node], [data-global-run-after-heading], [data-prompt-queue-edge-controls], [data-prompt-queue-item]')
      .forEach(element => observer.observe(element));
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [geometryKey, showDisabled, widthLimit, resizeEnabled, onContentWidth]);
  return <div ref={canvasRef} data-global-run-after-queues data-global-run-after-graph
    style={{ position: 'relative', minWidth: 0, margin: '6px 2px 0' }}>
    {!primary.size && <div data-global-run-after-empty style={{ position: 'absolute', top: 0, left: 8, width: 'max-content', maxWidth: 'var(--ra-layout-width)', color: '#777', fontSize: 11 }}>Нет активных цепочек Run After</div>}
    {visible.map(tab => <QueueBlock key={tab.id} tab={tab}
      queue={queues.get(tab.id) || usePromptQueueStore.getState().getQueue(tab.id)} busy={busy.get(tab.id) === true}
      awaited={awaitedTargets.has(tab.id)}
      graphTargets={graphTargets} register={register} onRewindTargetModeChange={onRewindTargetModeChange}
      onHoverGestureChange={onHoverGestureChange} />)}
    {!!disabled.size && <div ref={shelfRef} data-global-run-after-disabled-shelf
      style={{ position: 'absolute', left: 0, top: 0, width: '100%', borderTop: '1px solid #2e2e2e', paddingTop: 7 }}>
      <button type="button" className="gra-control" aria-expanded={showDisabled}
        onClick={() => { if (!showDisabled || beforeCloseRef.current()) setShowDisabled(value => !value); }}
        style={{ ...button, height: 25, display: 'inline-flex', alignItems: 'center', gap: 5, color: '#8f8f95' }}>
        {showDisabled ? <EyeOff size={12} /> : <Eye size={12} />} Выключенные · {disabled.size}
      </button>
    </div>}
    <svg ref={svgRef} aria-hidden data-global-run-after-links
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 2 }}>
      <defs><marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
        <path d="M 0 0 L 8 4 L 0 8 z" fill="#9b83e3" />
      </marker></defs>
      {visibleEdges.map(edge => <g key={edge.source + ':' + edge.itemId}><path data-run-after-edge={edge.kind}
        data-run-after-edge-owner={edge.source} data-run-after-edge-target={edge.target} data-run-after-edge-item={edge.itemId}
        fill="none" stroke={edge.kind === 'current' ? '#9b83e3' : '#676072'} strokeWidth={1.2}
        strokeDasharray={edge.kind === 'current' ? undefined : '3 3'} markerEnd={`url(#${markerId})`} />
        <circle data-run-after-source-dot={edge.itemId} r={2} fill={edge.kind === 'current' ? '#a78bfa' : '#8c7caa'} />
      </g>)}
    </svg>
  </div>;
}

export function GlobalRunAfterControl() {
  const [mode, setMode] = useState<'hidden' | 'preview' | 'pinned'>('hidden');
  const [page, setPage] = useState<'queues' | 'compact'>('queues');
  const [pickingRewind, setPickingRewind] = useState(false);
  const [editorGestureActive, setEditorGestureActive] = useState(false);
  const [panelSize, setPanelSize] = useState(loadPanelSize);
  const [position, setPosition] = useState({ left: PANEL_MARGIN, top: 65, width: PANEL_DEFAULT_W, height: PANEL_DEFAULT_H });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelContentRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const minimumWidthRef = useRef(PANEL_MIN_W);
  const contentWidthRef = useRef<number | null>(null);
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const [minimumWidth, setMinimumWidth] = useState(PANEL_MIN_W);
  // Closing the popup or visiting AutoCompact is not permission to reorder
  // the same tab cards when the user returns. No persisted queue state changes.
  const layoutMemoryRef = useRef<QueueLayoutMemory>({ primary: null, secondary: null });
  const beforeCloseRef = useRef<(reason?: 'outside') => boolean>(() => true);
  const resizeActiveRef = useRef(false);
  const onContentWidth = useCallback((width: number) => {
    const next = Math.ceil(width);
    contentWidthRef.current = next;
    if (!resizeActiveRef.current) setContentWidth(previous => previous === next ? previous : next);
  }, []);
  const editorGestureActiveRef = useRef(false);
  const previewPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const hoverReturnRef = useRef(createHoverReturnGate());
  const handleEditorGesture = useCallback((active: boolean, point: { clientX: number; clientY: number } | null) => {
    // Captured pointermove/native drag can suppress compatibility mousemove.
    // Forward actual gesture coordinates; never recover with a delayed close.
    previewPointerRef.current = point;
    if (editorGestureActiveRef.current === active) return;
    editorGestureActiveRef.current = active;
    setEditorGestureActive(active);
  }, []);
  const sidebarWidth = useUIStore((state) => state.tabSidebarWidth);
  const policy = useAutoCompactStore((state) => state.policy);
  const activities = useAutoCompactStore((state) => state.activities);
  const inventory = useAutomationInventory();
  const busy = useAutomationBusyTabs();
  const queues = usePromptQueueStore((state) => state.queues);
  const activeCount = inventory.tabs.filter((tab) => {
    const queue = queues.get(tab.id);
    return !!queue && hasPendingPromptQueueContinuation(queue);
  }).length;
  const runningCompacts = useMemo(
    () => summarizeRunningAutoCompacts(activities, inventory.tabs),
    [activities, inventory.tabs],
  );
  const visible = mode !== 'hidden';
  const fittedWidth = Math.min(position.width, Math.max(minimumWidth, contentWidth ?? position.width));
  const closePanel = useCallback((reason?: 'outside') => {
    // Hover dismissal is an editor exit too. Blur fields before unmount so
    // threshold/timer edits take the same save path as an ordinary blur.
    const active = document.activeElement;
    if (active instanceof HTMLElement && panelRef.current?.contains(active)) active.blur();
    if (!beforeCloseRef.current(reason)) return false;
    hoverReturnRef.current.reset();
    setMode('hidden');
    return true;
  }, []);
  const lastPositionWarningRef = useRef(0);
  useEffect(() => {
    console.log('[GlobalRunAfter:Presentation] mode=' + mode + ' activeQueues=' + activeCount);
  }, [mode]);

  useEffect(() => {
    try { localStorage.setItem(GLOBAL_PANEL_SIZE_KEY, JSON.stringify(panelSize)); } catch {}
  }, [panelSize]);

  useLayoutEffect(() => {
    if (!visible) return;
    const measure = () => {
      const started = performance.now();
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportW = Math.max(1, window.innerWidth);
      const viewportH = Math.max(1, window.innerHeight);
      const maxW = Math.max(1, viewportW - PANEL_MARGIN * 2);
      const controlsWidth = globalRunAfterMinimumWidth(panelRef.current, pagesRef.current);
      minimumWidthRef.current = controlsWidth;
      setMinimumWidth(previous => previous === controlsWidth ? previous : controlsWidth);
      const width = Math.min(Math.max(panelSize.width, controlsWidth), maxW);
      const displayedWidth = panelSize.resizeEnabled ? width : Math.min(width, Math.max(controlsWidth, contentWidth ?? width));
      const left = clamp(rect.left, PANEL_MARGIN, viewportW - displayedWidth - PANEL_MARGIN);
      const top = Math.max(PANEL_MARGIN, rect.bottom + PANEL_GAP);
      const maxH = Math.max(1, viewportH - top - PANEL_MARGIN);
      const height = Math.min(panelSize.height, maxH);
      setPosition(previous => retainPanelPosition(previous, { left, top, width, height }));
      const elapsed = performance.now() - started;
      if (elapsed > 8 && started - lastPositionWarningRef.current > 1000) {
        lastPositionWarningRef.current = started;
        console.warn('[Perf:GlobalRunAfterPosition] measureMs=' + elapsed.toFixed(1));
      }
    };
    const onAncestorScroll = (event: Event) => {
      if (scrollMovesAnchor(event.target, triggerRef.current)) measure();
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (pagesRef.current) observer?.observe(pagesRef.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', onAncestorScroll, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', onAncestorScroll, true);
    };
  }, [panelSize, sidebarWidth, visible, contentWidth]);

  const recheckPreviewHover = useCallback((point: { clientX: number; clientY: number } | null) => {
    if (mode !== 'preview' || pickingRewind || editorGestureActive || resizeActiveRef.current) return;
    if (!point) { closePanel(); return; }
    const panelRect = panelRef.current?.getBoundingClientRect() || null;
    const satelliteRects = [triggerRef.current?.getBoundingClientRect() || null,
      ...Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
        '[data-global-run-after-pages], [data-global-run-after-resize]',
      ) || []).map(element => element.getBoundingClientRect())];
    const insideParent = [panelRect, ...satelliteRects].some(rect => pointInRect(rect, point.clientX, point.clientY, 2));
    if (hoverReturnRef.current.holds(point, insideParent)) return;
    satelliteRects.push(...queueHoverSatelliteRects(panelRef.current));
    if (pointInHoverCluster({ hub: panelRect, satellites: satelliteRects, x: point.clientX, y: point.clientY, pad: 2 })) return;
    closePanel();
  }, [closePanel, editorGestureActive, mode, pickingRewind]);
  const recheckPreviewHoverRef = useRef(recheckPreviewHover);
  recheckPreviewHoverRef.current = recheckPreviewHover;
  useEffect(() => {
    if (mode !== 'preview') { hoverReturnRef.current.reset(); return; }
    const onChildClick = (event: MouseEvent) => captureQueueHoverReturn(event, panelRef.current, hoverReturnRef.current);
    const onMove = (event: MouseEvent) => {
      previewPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      recheckPreviewHover(event);
    };
    const onExitWindow = () => { previewPointerRef.current = null; recheckPreviewHover(null); };
    const onMouseOut = (event: MouseEvent) => { if (!event.relatedTarget) onExitWindow(); };
    // Rewind temporarily hides the surface, not its ownership. Once target
    // selection ends, recheck the real last pointer even without a new move.
    recheckPreviewHover(previewPointerRef.current);
    window.addEventListener('click', onChildClick, true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseout', onMouseOut);
    window.addEventListener('blur', onExitWindow);
    return () => {
      window.removeEventListener('click', onChildClick, true);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseout', onMouseOut);
      window.removeEventListener('blur', onExitWindow);
    };
  }, [mode, recheckPreviewHover]);

  const { start: startResizeGesture } = usePointerGesture();
  const startResize = useCallback((edge: 'right' | 'bottom' | 'corner', event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !panelSize.resizeEnabled) return;
    minimumWidthRef.current = globalRunAfterMinimumWidth(panelRef.current, pagesRef.current);
    previewPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    const liveRect = panelRef.current?.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    // Start from the geometry under the pointer. In auto-height mode the saved
    // height is only a ceiling; using it here made the first bottom move jump
    // from a short 180px panel straight to the old 600px cap.
    const startWidth = liveRect?.width || position.width;
    const startHeight = liveRect?.height || position.height;
    const maxWidth = window.innerWidth - position.left - PANEL_MARGIN;
    const maxHeight = window.innerHeight - position.top - PANEL_MARGIN;
    let nextWidth = edge === 'bottom' ? panelSize.width : startWidth;
    let nextHeight = edge === 'right' ? panelSize.height : startHeight;
    let moved = false;
    startResizeGesture(event, {
      cursor: edge === 'right' ? 'ew-resize' : edge === 'bottom' ? 'ns-resize' : 'nwse-resize',
      onMove: (moveEvent) => {
        previewPointerRef.current = { clientX: moveEvent.clientX, clientY: moveEvent.clientY };
        const width = edge === 'bottom' ? startWidth
          : clamp(startWidth + moveEvent.clientX - startX, Math.min(minimumWidthRef.current, maxWidth), maxWidth);
        const height = edge === 'right' ? startHeight
          : clamp(startHeight + moveEvent.clientY - startY, Math.min(170, maxHeight), maxHeight);
        nextWidth = edge === 'bottom' ? panelSize.width : width;
        nextHeight = edge === 'right' ? panelSize.height : height;
        moved = true;
        // Live geometry belongs to this Blur/resize shell only. React/store
        // commit once on pointerup; rerendering every graph node on every move
        // recreated the same resize lag fixed in the workspace dividers.
        if (panelRef.current) {
          if (edge !== 'bottom') panelRef.current.style.width = `${width}px`;
          if (edge !== 'right') {
            panelRef.current.style.height = `${height}px`;
            panelRef.current.style.maxHeight = `${height}px`;
          }
        }
        if (edge !== 'right' && panelContentRef.current) panelContentRef.current.style.maxHeight = 'none';
      },
      onEnd: (reason, endEvent) => {
        resizeActiveRef.current = false;
        if (endEvent) previewPointerRef.current = { clientX: endEvent.clientX, clientY: endEvent.clientY };
        const recheckAfterGesture = () => {
          if (reason !== 'dispose') recheckPreviewHoverRef.current(previewPointerRef.current);
        };
        if (!moved || reason !== 'up') {
          if (panelRef.current) {
            panelRef.current.style.width = `${position.width}px`;
            panelRef.current.style.height = panelSize.resizeEnabled ? `${position.height}px` : 'auto';
            panelRef.current.style.maxHeight = `${position.height}px`;
          }
          if (panelContentRef.current) {
            panelContentRef.current.style.maxHeight = panelSize.resizeEnabled
              ? 'none'
              : `${Math.max(90, position.height - 26)}px`;
          }
          recheckAfterGesture();
          return;
        }
        setPanelSize({
          width: nextWidth,
          height: nextHeight,
          resizeEnabled: true,
        });
        if (contentWidthRef.current !== null) setContentWidth(contentWidthRef.current);
        recheckAfterGesture();
      },
    });
    resizeActiveRef.current = true;
  }, [panelSize, position, startResizeGesture]);

  const switchPage = (next: 'queues' | 'compact') => {
    if (next === page) return;
    if (!beforeCloseRef.current()) return;
    setPage(next);
  };
  const togglePinned = () => {
    if (mode === 'pinned') {
      closePanel();
      return;
    }
    setMode('pinned');
  };

  return (
    <>
      <style>{`
        @keyframes gra-auto-compact-spin { to { transform: rotate(360deg); } }
        @keyframes gra-auto-compact-edge-travel {
          from { transform: translateY(-110%); }
          to { transform: translateY(245%); }
        }
        .gra-auto-compact-spinner { animation: gra-auto-compact-spin 0.9s linear infinite; }
        .gra-auto-compact-edge-sweep { animation: gra-auto-compact-edge-travel 1.15s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .gra-auto-compact-spinner, .gra-auto-compact-edge-sweep { animation: none; }
          .gra-auto-compact-edge-sweep { transform: translateY(20%); }
        }
      `}</style>
      <button ref={triggerRef} type="button" data-global-run-after-trigger aria-expanded={visible}
        aria-label={`Run After · ${activeCount}`}
        data-global-run-after-auto-compact-running={runningCompacts.total || undefined}
        onMouseEnter={(event) => {
          previewPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
          if (mode === 'hidden') setMode('preview');
        }} onClick={togglePinned}
        title={runningCompacts.total > 0
          ? `Очереди всех вкладок и глобальный автокомпакт · выполняется: ${runningCompacts.total}`
          : 'Очереди всех вкладок и глобальный автокомпакт'} style={{ ...button, position: 'relative', display: 'inline-flex', alignItems: 'center',
          gap: 5, height: 26, padding: '0 6px', flexShrink: 0, whiteSpace: 'nowrap', color: visible ? '#dfab78' : '#aaa',
          borderColor: visible ? '#805739' : '#373737', zIndex: visible ? 15001 : undefined }}>
        {mode === 'hidden' && runningCompacts.total > 0 && <span aria-hidden data-global-run-after-auto-compact-edge
          style={{ position: 'absolute', left: 0, top: 2, bottom: 2, width: 1, overflow: 'hidden',
            background: 'rgba(139,92,246,0.24)', pointerEvents: 'none' }}>
          <span className="gra-auto-compact-edge-sweep" style={{ position: 'absolute', left: 0, top: 0, width: 1,
            height: '44%', background: 'linear-gradient(180deg, transparent, #ddd6fe 42%, #8b5cf6 68%, transparent)',
            willChange: 'transform' }} />
        </span>}
        <GitBranch size={13} aria-hidden="true" /> {activeCount}
        {policy.enabled && <Percent size={11} color="#d9a76f" aria-label={`Автокомпакт включён при ${policy.percent}%`} />}
      </button>

      {visible && createPortal(
        <>
          {!pickingRewind && (
            <div
              data-global-run-after-overlay
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                closePanel('outside');
              }}
              style={{ position: 'fixed', inset: 0, zIndex: 14999, background: 'transparent' }}
            />
          )}
          <div ref={panelRef} data-global-run-after-panel data-global-run-after-mode={mode}
            data-global-run-after-sizing={panelSize.resizeEnabled ? 'resize' : 'content'}
            style={{ position: 'fixed', zIndex: 15000, left: position.left, top: position.top, width: panelSize.resizeEnabled ? position.width : fittedWidth,
              height: panelSize.resizeEnabled ? position.height : 'auto', maxHeight: position.height,
              boxSizing: 'border-box', visibility: pickingRewind ? 'hidden' : 'visible', display: 'flex',
              flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'visible', background: '#181818', color: '#ccc',
              border: `1px solid ${mode === 'pinned' ? 'rgba(255,255,255,0.34)' : '#414141'}`, borderRadius: 9,
              padding: '18px 9px 8px', fontSize: 12, boxShadow: '0 12px 35px #0008' }}>
        <div ref={pagesRef} data-global-run-after-pages style={{ position: 'absolute', top: 0, left: 12, transform: 'translateY(-50%)',
          display: 'inline-flex', gap: 4, alignItems: 'center', padding: '0 4px', background: '#181818', zIndex: 3 }}>
          <button type="button" className="gra-page" onClick={() => switchPage('queues')} aria-pressed={page === 'queues'}
            style={{ ...button, height: 28, padding: '0 9px', color: page === 'queues' ? '#e6bb8b' : '#929297',
              borderColor: page === 'queues' ? '#79583b' : '#363636' }}>Очереди · {activeCount}</button>
          <button type="button" className="gra-page" onClick={() => switchPage('compact')} aria-pressed={page === 'compact'}
            style={{ ...button, height: 28, padding: '0 9px', display: 'inline-flex', alignItems: 'center', gap: 5,
              color: page === 'compact' ? '#e6bb8b' : '#929297',
              borderColor: page === 'compact' ? '#79583b' : '#363636' }}>
            <span>Автокомпакт{policy.enabled ? ` · ≥${policy.percent}%` : ''}</span>
            {runningCompacts.total > 0 && <AutoCompactRunningIndicator count={runningCompacts.total} scope="global" />}
          </button>
          <button type="button" className="gra-page" data-global-run-after-resize-toggle
            aria-label="Настроить размер" aria-pressed={panelSize.resizeEnabled}
            title={panelSize.resizeEnabled ? 'Скрыть настройку размера' : 'Настроить предел ширины и высоты'}
            onClick={() => {
              if (contentWidthRef.current !== null) setContentWidth(contentWidthRef.current);
              setPanelSize(current => ({ ...current, resizeEnabled: !current.resizeEnabled }));
            }}
            style={{ ...button, width: 28, height: 28, padding: 0, display: 'grid', placeItems: 'center',
              color: panelSize.resizeEnabled ? '#a78bfa' : '#929297',
              borderColor: panelSize.resizeEnabled ? '#8b5cf6' : '#363636' }}><PanelRightDashed size={14} /></button>
        </div>

        <div ref={panelContentRef} data-global-run-after-content style={{ flex: panelSize.resizeEnabled ? 1 : '0 1 auto', minHeight: 0,
          maxHeight: panelSize.resizeEnabled ? 'none' : Math.max(0, position.height - 28),
          overflow: 'auto', scrollbarGutter: 'stable' }}>
          {page === 'compact' ? <AutoCompactPage inventory={inventory} busy={busy} widthLimit={position.width}
            resizeEnabled={panelSize.resizeEnabled} onContentWidth={onContentWidth} /> :
            <QueueOverview inventory={inventory} queues={queues} busy={busy} beforeCloseRef={beforeCloseRef}
              layoutMemoryRef={layoutMemoryRef} widthLimit={position.width} resizeEnabled={panelSize.resizeEnabled} onContentWidth={onContentWidth}
              onRewindTargetModeChange={setPickingRewind} onHoverGestureChange={handleEditorGesture} />}
        </div>

        {panelSize.resizeEnabled && <>
        <div data-global-run-after-resize="right" onPointerDown={(event) => startResize('right', event)}
          style={{ position: 'absolute', top: 10, right: -4, bottom: 14, width: 8, cursor: 'ew-resize',
            userSelect: 'none', touchAction: 'none', zIndex: 2 }}>
          <span style={{ position: 'absolute', left: 3, top: 0, bottom: 0, width: 2, borderRadius: 2, background: '#a78bfa' }} />
        </div>
        <div data-global-run-after-resize="bottom" onPointerDown={(event) => startResize('bottom', event)}
          style={{ position: 'absolute', left: 10, right: 14, bottom: -4, height: 8, cursor: 'ns-resize',
            userSelect: 'none', touchAction: 'none', zIndex: 2 }}>
          <span style={{ position: 'absolute', top: 3, left: 0, right: 0, height: 2, borderRadius: 2, background: '#60a5fa' }} />
        </div>
        <div data-global-run-after-resize="corner" onPointerDown={(event) => startResize('corner', event)} title="Изменить размер"
          style={{ position: 'absolute', right: -3, bottom: -3, width: 15, height: 15, cursor: 'nwse-resize',
            userSelect: 'none', touchAction: 'none', zIndex: 4,
            background: 'linear-gradient(135deg, transparent 52%, #a78bfa 53%, #a78bfa 61%, transparent 62%, transparent 72%, #60a5fa 73%, #60a5fa 80%, transparent 81%)',
            borderRadius: '0 0 8px 0' }} />
        </>}

        <style>{`
          .gra-control, .gra-choice, .gra-page, .gra-node-action {
            transition: none;
          }
          .gra-control:not(:disabled):hover,
          .gra-choice:not(:disabled):hover,
          .gra-page:not(:disabled):hover,
          .gra-node-action:not(:disabled):hover {
            filter: brightness(1.18);
            box-shadow: inset 0 0 0 999px rgba(255,255,255,0.035);
          }
          .gra-control:focus-visible,
          .gra-choice:focus-visible,
          .gra-page:focus-visible,
          .gra-node-action:focus-visible {
            outline: none;
            box-shadow: 0 0 0 2px rgba(167,139,250,0.36), inset 0 0 0 999px rgba(255,255,255,0.04);
          }
          .gra-number::-webkit-inner-spin-button,
          .gra-number::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
          .gra-number { appearance: textfield; }
        `}</style>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
