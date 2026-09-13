import { usePointerGesture } from '../../hooks/usePointerGesture';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Ban,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Folder,
  GitBranch,
  Pause,
  Percent,
  Play,
  Power,
  Repeat2,
  Timer,
} from 'lucide-react';
import {
  countEnabledQueuedPrompts,
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
import { getHistoryAgentRuntime } from '../../utils/historyAgentRuntimes';
import { pointInHoverCluster } from '../../utils/hoverBridge.mjs';
import { layoutRunAfterDependencyGraph } from '../../utils/runAfterDependencyLayout.mjs';
import {
  resolveTabCardBackground,
  resolveTabCardBoxHeight,
  resolveTabCardMetrics,
  TAB_CARD_LINE_HEIGHT,
} from '../../utils/tabCardVisual.mjs';
import { resolveRunAfterPlayAppearance } from '../../utils/runAfterPlayAppearance';
import { requestTabPrimaryInputFocus } from '../../utils/tabPrimaryInputFocus';
import ControlHint from '../UI/ControlHint';
import { PromptQueueOverlay } from './PromptQueueOverlay';
import { TabPaneMap } from './PaneMap';
import { TabProcessBar } from './TabSignals';
import { adjustRgbaAlpha, getTabChromeColorConfig } from './tabChrome';

const PANEL_MARGIN = 8;
// Page controls straddle the top frame by 14px. The full gap therefore owns
// that outside half instead of letting it overlap the navigation row.
const PANEL_GAP = 17;
const PANEL_MIN_W = 520;
const PANEL_MIN_H = 330;
const PANEL_DEFAULT_W = 760;
const PANEL_DEFAULT_H = 600;
const GRAPH_NODE_W = 214;
const GLOBAL_PANEL_SIZE_KEY = 'noted-terminal-global-run-after-size';

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

function loadPanelSize(): { width: number; height: number } {
  try {
    const parsed = JSON.parse(localStorage.getItem(GLOBAL_PANEL_SIZE_KEY) || '{}');
    return {
      width: Number.isFinite(parsed.width) ? Math.max(PANEL_MIN_W, parsed.width) : PANEL_DEFAULT_W,
      height: Number.isFinite(parsed.height) ? Math.max(PANEL_MIN_H, parsed.height) : PANEL_DEFAULT_H,
    };
  } catch {
    return { width: PANEL_DEFAULT_W, height: PANEL_DEFAULT_H };
  }
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

function queueHead(queue: TabQueue | undefined) {
  return queue?.items.find(isQueuedPromptEnabled);
}

function queueHeadTarget(queue: TabQueue | undefined): string | null {
  const head = queueHead(queue);
  if (head?.trigger?.kind === 'onTab') return head.trigger.tabId;
  return queue?.runAfterTabId || null;
}

function QueueStatusMarks({ queue, activityMessage }: {
  queue: TabQueue;
  activityMessage?: string;
}) {
  const head = queueHead(queue);
  const condition = head?.condition;
  const timer = head?.trigger?.kind === 'timer' ? head.trigger.seconds : null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
      {condition && (
        <span
          title={`Контекст использован ${condition.operator === 'gte' ? 'не меньше' : 'не больше'} ${condition.percent}%`}
          style={{ color: '#82d9a4', fontSize: 9.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {condition.operator === 'gte' ? '≥' : '≤'}{condition.percent}%
        </span>
      )}
      {timer !== null && (
        <span title={`Таймер ${timer} секунд`} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: '#c9a46c', fontSize: 9.5 }}>
          <Timer size={9} />{timer}s
        </span>
      )}
      {queue.loopPromptEnabled && <Repeat2 size={10} color="#a78bfa" aria-label="Loop включён" />}
      {activityMessage && <Percent size={10} color="#d5b48b" aria-label={activityMessage} />}
    </span>
  );
}

function QueueTabNode({ tab, queue, busy, selected, onEdit }: {
  tab: AutomationTab;
  queue?: TabQueue;
  busy: boolean;
  selected: boolean;
  onEdit: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [runHovered, setRunHovered] = useState(false);
  const active = useWorkspaceStore((state) => (
    state.activeProjectId === tab.projectId
    && state.openProjects.get(tab.projectId)?.activeTabId === tab.id
  ));
  const tabGeo = useUIStore((state) => state.tabGeometry);
  const tabsFontSize = useUIStore((state) => state.tabsFontSize);
  const activity = useAutoCompactStore((state) => state.activities[tab.id]);
  const chrome = getTabChromeColorConfig({ color: tab.color, tabType: tab.tabType });
  const hasColor = !!tab.color && tab.color !== 'default';
  const metrics = resolveTabCardMetrics(tabGeo, { fontSize: tabsFontSize });
  const count = queue ? countEnabledQueuedPrompts(queue.items) : 0;
  const runAppearance = resolveRunAfterPlayAppearance({
    autoRun: queue?.autoRun === true,
    activeItemCount: count,
    firstChipArmedHint: queue?.firstChipHintActive === true,
    hovered: runHovered,
  });

  const navigate = () => {
    useWorkspaceStore.getState().activateCenterTab(tab.projectId, tab.id);
    useUIStore.getState().setActiveArea('workspace');
    requestTabPrimaryInputFocus(tab.id, 'global-run-after-tab');
  };

  const placeHere = (event: React.MouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    useWorkspaceStore.getState().placeTab(tab.projectId, tab.id, { mode: 'add-here' });
    useUIStore.getState().setActiveArea('workspace');
    requestTabPrimaryInputFocus(tab.id, 'global-run-after-add-here');
  };

  return (
    <div
      data-global-run-after-node={tab.id}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'stretch',
        gap: 3,
        zIndex: 2,
        borderRadius: metrics.borderRadius,
        boxShadow: selected ? '0 0 0 1px rgba(167,139,250,0.72)' : undefined,
      }}
    >
      <button
        type="button"
        data-global-run-after-tab-chip={tab.id}
        onClick={navigate}
        onAuxClick={placeHere}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={`${tab.name} · ${tab.projectName}\nКлик — перейти; средний клик — поместить в текущее окно`}
        style={{
          position: 'relative',
          flex: 1,
          minWidth: 0,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: metrics.padding,
          boxSizing: 'border-box',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          fontFamily: 'inherit',
          fontSize: metrics.fontSize,
          lineHeight: TAB_CARD_LINE_HEIGHT,
          color: active || hovered ? '#fff' : '#b2b2b7',
          cursor: 'pointer',
          borderRadius: metrics.borderRadius,
          border: `1px solid ${hasColor ? chrome.borderColor : '#3a3a3d'}`,
          background: resolveTabCardBackground(
            { bgColor: chrome.bgColor, hasColor, active, hovered, selected },
            adjustRgbaAlpha,
          ),
        }}
      >
        <TabProcessBar hasProcess={false} busy={busy} inheritedBusy={false} radius={metrics.borderRadius} zIndex={1} />
        {tab.projectIcon ? (
          <img src={tab.projectIcon} alt="" style={{ width: 16, height: 16, objectFit: 'contain', flexShrink: 0 }} />
        ) : (
          <Folder size={15} color="#987bb9" style={{ flexShrink: 0 }} />
        )}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' }}>
          {tab.name}
        </span>
        {queue && <QueueStatusMarks queue={queue} activityMessage={activity?.message} />}
        <TabPaneMap projectId={tab.projectId} tabId={tab.id} />
      </button>

      {queueIsConfigured(queue) && (
        <>
          <ControlHint label={selected ? 'Свернуть редактор очереди' : 'Открыть редактор очереди'} shortcut={`${count} активных шагов`} side="top">
            <button
              type="button"
              className="gra-node-action"
              data-global-run-after-editor-trigger={tab.id}
              aria-expanded={selected}
              onClick={onEdit}
              style={{
                ...button,
                width: 29,
                padding: 0,
                display: 'grid',
                placeItems: 'center',
                flexShrink: 0,
                fontSize: 10,
                fontWeight: count ? 700 : 500,
                color: selected ? '#f0b47e' : '#aaa',
                borderColor: selected ? '#99603b' : '#3a3a3d',
                background: selected ? 'rgba(147,75,33,0.20)' : '#202020',
              }}
            >
              {count > 99 ? '99' : count}
            </button>
          </ControlHint>
          <ControlHint
            label={queue?.autoRun ? 'Приостановить Run After' : 'Запустить Run After'}
            shortcut={count ? `${count} активных шагов` : 'Нет активных шагов'}
            side="top"
            disabled={count === 0}
          >
            <button
              type="button"
              className="gra-node-action"
              disabled={count === 0}
              aria-label={queue?.autoRun ? 'Приостановить Run After' : 'Запустить Run After'}
              aria-pressed={queue?.autoRun === true}
              onMouseEnter={() => setRunHovered(true)}
              onMouseLeave={() => setRunHovered(false)}
              onClick={() => {
                if (!queue || count === 0) return;
                usePromptQueueStore.getState().setAutoRun(tab.id, !queue.autoRun);
              }}
              style={{
                ...button,
                width: 29,
                padding: 0,
                display: 'grid',
                placeItems: 'center',
                flexShrink: 0,
                background: runAppearance.background,
                borderColor: runAppearance.borderColor,
                color: runAppearance.color,
                opacity: runAppearance.opacity,
                cursor: count ? 'pointer' : 'default',
              }}
            >
              {queue?.autoRun ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="none" style={{ marginLeft: 1 }} />}
            </button>
          </ControlHint>
        </>
      )}
    </div>
  );
}

type DependencyEdge = { source: string; target: string; kind: 'current' | 'future' };

function collectQueueRelations(ownerId: string, queue: TabQueue): DependencyEdge[] {
  const enabled = queue.items.filter(isQueuedPromptEnabled);
  const head = enabled[0];
  const currentTarget = queueHeadTarget(queue);
  const relations: DependencyEdge[] = [];
  enabled.forEach((item, index) => {
    if (item.trigger?.kind !== 'onTab') return;
    relations.push({
      source: item.trigger.tabId,
      target: ownerId,
      kind: index === 0 && item.trigger.tabId === currentTarget ? 'current' : 'future',
    });
  });
  if (currentTarget && head?.trigger?.kind !== 'onTab') {
    relations.push({ source: currentTarget, target: ownerId, kind: 'current' });
  }
  return relations;
}

function edgePath(source: { x: number; y: number; width: number; height: number }, target: { x: number; y: number; width: number; height: number }) {
  const sx = source.x + source.width;
  const sy = source.y + source.height / 2;
  const tx = target.x;
  const ty = target.y + target.height / 2;
  if (tx > sx) {
    const bend = Math.max(16, (tx - sx) * 0.52);
    return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`;
  }
  const top = Math.max(4, Math.min(sy, ty) - 18);
  return `M ${sx} ${sy} C ${sx + 18} ${top}, ${tx - 18} ${top}, ${tx} ${ty}`;
}

function QueueDependencyMap({ inventory, queues, busy, selectedId, onSelect }: {
  inventory: ReturnType<typeof useAutomationInventory>;
  queues: Map<string, TabQueue>;
  busy: Map<string, boolean>;
  selectedId: string | null;
  onSelect: (tabId: string) => void;
}) {
  const tabGeo = useUIStore((state) => state.tabGeometry);
  const tabsFontSize = useUIStore((state) => state.tabsFontSize);
  const nodeHeight = Math.max(31, resolveTabCardBoxHeight(tabGeo, { fontSize: tabsFontSize }));
  const tabMap = useMemo(() => new Map(inventory.tabs.map((tab) => [tab.id, tab])), [inventory.tabs]);
  const activeOwners = useMemo(() => inventory.tabs.filter((tab) => {
    const queue = queues.get(tab.id);
    return !!queue && hasPendingPromptQueueContinuation(queue);
  }), [inventory.tabs, queues]);

  const projection = useMemo(() => {
    const nodeIds = new Set(activeOwners.map((tab) => tab.id));
    const edges: DependencyEdge[] = [];
    for (const tab of activeOwners) {
      const queue = queues.get(tab.id);
      if (!queue) continue;
      for (const edge of collectQueueRelations(tab.id, queue)) {
        if (!tabMap.has(edge.source)) continue;
        nodeIds.add(edge.source);
        edges.push(edge);
      }
    }
    const orderedNodeIds = inventory.tabs.map((tab) => tab.id).filter((id) => nodeIds.has(id));
    return layoutRunAfterDependencyGraph({
      nodeIds: orderedNodeIds,
      edges,
      nodeWidth: GRAPH_NODE_W,
      nodeHeight,
      columnGap: 34,
      rowGap: 12,
      padding: 8,
    });
  }, [activeOwners, inventory.tabs, nodeHeight, queues, tabMap]);

  if (!activeOwners.length) {
    return <div style={{ padding: '18px 8px', color: '#777', textAlign: 'center' }}>Нет активных цепочек Run After</div>;
  }

  return (
    <div data-global-run-after-graph style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 14, minWidth: 'min-content' }}>
      {projection.map((component: any, componentIndex: number) => {
        const currentMarker = `gra-current-${componentIndex}`;
        const futureMarker = `gra-future-${componentIndex}`;
        const positions = new Map(component.nodes.map((node: any) => [node.id, node]));
        return (
          <div key={component.id} data-global-run-after-component style={{ position: 'relative', width: component.width, height: component.height, flex: '0 0 auto' }}>
            <svg aria-hidden="true" width={component.width} height={component.height} viewBox={`0 0 ${component.width} ${component.height}`}
              style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible', zIndex: 0 }}>
              <defs>
                <marker id={currentMarker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 0 L 8 4 L 0 8 z" fill="#9b83e3" />
                </marker>
                <marker id={futureMarker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 0 L 8 4 L 0 8 z" fill="#66616f" />
                </marker>
              </defs>
              {component.edges.map((edge: DependencyEdge) => {
                const source = positions.get(edge.source) as any;
                const target = positions.get(edge.target) as any;
                if (!source || !target) return null;
                const current = edge.kind === 'current';
                return <path key={`${edge.source}-${edge.target}`} data-run-after-edge={edge.kind} d={edgePath(source, target)} fill="none"
                  stroke={current ? '#8b75d9' : '#5e5967'} strokeWidth={current ? 1.6 : 1.15}
                  strokeDasharray={current ? undefined : '4 4'} markerEnd={`url(#${current ? currentMarker : futureMarker})`}
                  vectorEffect="non-scaling-stroke" />;
              })}
            </svg>
            {component.nodes.map((node: any) => {
              const tab = tabMap.get(node.id);
              if (!tab) return null;
              const queue = queues.get(node.id);
              return (
                <div key={node.id} style={{ position: 'absolute', left: node.x, top: node.y, width: node.width, height: node.height }}>
                  <QueueTabNode tab={tab} queue={queueIsConfigured(queue) ? queue : undefined} busy={busy.get(tab.id) === true}
                    selected={selectedId === tab.id} onEdit={() => onSelect(tab.id)} />
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
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

type Candidate = { tab: AutomationTab; percent: number; stopped: boolean };

function AutoCompactPage({ inventory, busy }: {
  inventory: ReturnType<typeof useAutomationInventory>;
  busy: Map<string, boolean>;
}) {
  const policy = useAutoCompactStore((state) => state.policy);
  const hydrated = useAutoCompactStore((state) => state.hydrated);
  const activities = useAutoCompactStore((state) => state.activities);
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
    <div data-global-auto-compact style={{ padding: '10px 2px 4px' }}>
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
            return (
              <ChoiceChip key={group.id} selected={selectedGroup} disabled={!hydrated || (!unplaced && policy.allWorkflows)}
                title={group.projectNames.length ? group.projectNames.join(', ') : undefined}
                onClick={() => {
                  if (unplaced) update({ includeUnplaced: !policy.includeUnplaced });
                  else update({ workflowIds: policy.workflowIds.includes(group.id)
                    ? policy.workflowIds.filter((id: string) => id !== group.id)
                    : [...policy.workflowIds, group.id] });
                }}>
                {group.name}
              </ChoiceChip>
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

function QueueOverview({ inventory, queues, busy, selectedId, setSelectedId, beforeCloseRef, onRewindTargetModeChange }: {
  inventory: ReturnType<typeof useAutomationInventory>;
  queues: Map<string, TabQueue>;
  busy: Map<string, boolean>;
  selectedId: string | null;
  setSelectedId: (tabId: string | null) => void;
  beforeCloseRef: { current: (reason?: 'outside') => boolean };
  onRewindTargetModeChange: (active: boolean) => void;
}) {
  const [showDisabled, setShowDisabled] = useState(false);
  const tabGeo = useUIStore((state) => state.tabGeometry);
  const tabsFontSize = useUIStore((state) => state.tabsFontSize);
  const disabledNodeHeight = Math.max(31, resolveTabCardBoxHeight(tabGeo, { fontSize: tabsFontSize }));
  const activeIds = useMemo(() => new Set(inventory.tabs.filter((tab) => {
    const queue = queues.get(tab.id);
    return !!queue && hasPendingPromptQueueContinuation(queue);
  }).map((tab) => tab.id)), [inventory.tabs, queues]);
  const graphIds = useMemo(() => {
    const ids = new Set(activeIds);
    for (const ownerId of activeIds) {
      const queue = queues.get(ownerId);
      if (!queue) continue;
      for (const relation of collectQueueRelations(ownerId, queue)) ids.add(relation.source);
    }
    return ids;
  }, [activeIds, queues]);
  const disabledTabs = useMemo(() => inventory.tabs.filter((tab) => {
    const queue = queues.get(tab.id);
    return queueIsConfigured(queue) && !graphIds.has(tab.id);
  }), [graphIds, inventory.tabs, queues]);
  const selectedTab = selectedId ? inventory.tabs.find((tab) => tab.id === selectedId) : undefined;
  const selectedQueue = selectedId ? queues.get(selectedId) : undefined;

  const select = useCallback((tabId: string) => {
    if (!beforeCloseRef.current()) return;
    setSelectedId(selectedId === tabId ? null : tabId);
  }, [beforeCloseRef, selectedId, setSelectedId]);

  return (
    <div data-global-run-after-queues style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div data-global-run-after-map-scroll
        style={{ flex: 1, minHeight: 90, overflow: 'auto', scrollbarGutter: 'stable', padding: '2px 2px 9px' }}>
        <QueueDependencyMap inventory={inventory} queues={queues} busy={busy} selectedId={selectedId} onSelect={select} />

        {!!disabledTabs.length && <div style={{ marginTop: 8, borderTop: '1px solid #2e2e2e', paddingTop: 7 }}>
          <button type="button" className="gra-control" aria-expanded={showDisabled} onClick={() => setShowDisabled(!showDisabled)}
            style={{ ...button, height: 25, display: 'inline-flex', alignItems: 'center', gap: 5, color: '#8f8f95' }}>
            {showDisabled ? <EyeOff size={12} /> : <Eye size={12} />} Выключенные · {disabledTabs.length}
          </button>
          {showDisabled && <div data-global-run-after-disabled style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 7 }}>
            {disabledTabs.map((tab) => <div key={tab.id} style={{ width: GRAPH_NODE_W, height: disabledNodeHeight }}>
              <QueueTabNode tab={tab} queue={queues.get(tab.id)} busy={busy.get(tab.id) === true}
                selected={selectedId === tab.id} onEdit={() => select(tab.id)} />
            </div>)}
          </div>}
        </div>}
      </div>

      {selectedTab && selectedQueue && <div data-global-run-after-editor-area={selectedTab.id}
        style={{ position: 'relative', flex: '0 1 46%', minHeight: 175, maxHeight: '48%', borderTop: '1px solid #3a3a3a',
          padding: '17px 2px 2px', boxSizing: 'border-box' }}>
        <button type="button" className="gra-control" onClick={() => {
          if (beforeCloseRef.current()) setSelectedId(null);
        }} title="Свернуть редактор очереди" style={{ ...button, position: 'absolute', top: 0, left: 10,
          transform: 'translateY(-50%)', height: 24, padding: '0 7px', display: 'inline-flex', alignItems: 'center', gap: 5,
          background: '#181818', color: '#c8c3ce', maxWidth: 280 }}>
          <ChevronDown size={12} />
          {selectedTab.projectIcon ? <img src={selectedTab.projectIcon} alt="" style={{ width: 13, height: 13, objectFit: 'contain' }} /> : <Folder size={12} />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedTab.name}</span>
        </button>
        <PromptQueueOverlay tabId={selectedTab.id} sessionType={selectedTab.provider} agentBusy={busy.get(selectedTab.id) === true}
          inputSurface="history" embedded beforeCloseRef={beforeCloseRef} onRewindTargetModeChange={onRewindTargetModeChange} />
      </div>}
    </div>
  );
}

export function GlobalRunAfterControl() {
  const [mode, setMode] = useState<'hidden' | 'preview' | 'pinned'>('hidden');
  const [page, setPage] = useState<'queues' | 'compact'>('queues');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickingRewind, setPickingRewind] = useState(false);
  const [panelSize, setPanelSize] = useState(loadPanelSize);
  const [position, setPosition] = useState({ left: PANEL_MARGIN, top: 65, width: PANEL_DEFAULT_W, height: PANEL_DEFAULT_H });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const beforeCloseRef = useRef<(reason?: 'outside') => boolean>(() => true);
  const sidebarWidth = useUIStore((state) => state.tabSidebarWidth);
  const policy = useAutoCompactStore((state) => state.policy);
  const inventory = useAutomationInventory();
  const busy = useAutomationBusyTabs();
  const queues = usePromptQueueStore((state) => state.queues);
  const activeCount = inventory.tabs.filter((tab) => {
    const queue = queues.get(tab.id);
    return !!queue && hasPendingPromptQueueContinuation(queue);
  }).length;
  const visible = mode !== 'hidden';

  useEffect(() => {
    try { localStorage.setItem(GLOBAL_PANEL_SIZE_KEY, JSON.stringify(panelSize)); } catch {}
  }, [panelSize]);

  useLayoutEffect(() => {
    if (!visible) return;
    const measure = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportW = Math.max(1, window.innerWidth);
      const viewportH = Math.max(1, window.innerHeight);
      const maxW = Math.max(1, viewportW - PANEL_MARGIN * 2);
      const width = Math.min(panelSize.width, maxW);
      const left = clamp(rect.left, PANEL_MARGIN, viewportW - width - PANEL_MARGIN);
      const top = Math.max(PANEL_MARGIN, rect.bottom + PANEL_GAP);
      const maxH = Math.max(1, viewportH - top - PANEL_MARGIN);
      const height = Math.min(panelSize.height, maxH);
      setPosition({ left, top, width, height });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [panelSize, sidebarWidth, visible]);

  useEffect(() => {
    if (mode !== 'preview') return;
    const onMove = (event: MouseEvent) => {
      const panelRect = panelRef.current?.getBoundingClientRect() || null;
      const satelliteRects = [triggerRef.current?.getBoundingClientRect() || null,
        ...Array.from(document.querySelectorAll<HTMLElement>('[data-run-after-satellite], [data-run-after-picker-menu], [data-run-after-picker-overlay]'))
          .map((element) => element.getBoundingClientRect())];
      if (pointInHoverCluster({ hub: panelRect, satellites: satelliteRects, x: event.clientX, y: event.clientY, pad: 2 })) return;
      setMode('hidden');
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [mode]);

  const { start: startResizeGesture } = usePointerGesture();
  const startResize = useCallback((edge: 'right' | 'bottom' | 'corner', event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    setMode('pinned');
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = position.width;
    const startHeight = position.height;
    const maxWidth = window.innerWidth - position.left - PANEL_MARGIN;
    const maxHeight = window.innerHeight - position.top - PANEL_MARGIN;
    startResizeGesture(event, {
      cursor: edge === 'right' ? 'ew-resize' : edge === 'bottom' ? 'ns-resize' : 'nwse-resize',
      onMove: (moveEvent) => {
        const width = edge === 'bottom' ? startWidth
          : clamp(startWidth + moveEvent.clientX - startX, Math.min(PANEL_MIN_W, maxWidth), maxWidth);
        const height = edge === 'right' ? startHeight
          : clamp(startHeight + moveEvent.clientY - startY, Math.min(PANEL_MIN_H, maxHeight), maxHeight);
        setPanelSize({ width, height });
      },
    });
  }, [position, startResizeGesture]);

  const switchPage = (next: 'queues' | 'compact') => {
    if (next === page) return;
    if (!beforeCloseRef.current()) return;
    setSelectedId(null);
    setPage(next);
  };
  const togglePinned = () => {
    if (mode === 'pinned') {
      if (!beforeCloseRef.current()) return;
      setSelectedId(null);
      setMode('hidden');
      return;
    }
    setMode('pinned');
  };

  return (
    <>
      <button ref={triggerRef} type="button" data-global-run-after-trigger aria-expanded={visible}
        onMouseEnter={() => { if (mode === 'hidden') setMode('preview'); }} onClick={togglePinned}
        title="Очереди всех вкладок и глобальный автокомпакт" style={{ ...button, display: 'inline-flex', alignItems: 'center',
          gap: 5, height: 26, padding: '0 6px', flexShrink: 0, whiteSpace: 'nowrap', color: visible ? '#dfab78' : '#aaa',
          borderColor: visible ? '#805739' : '#373737' }}>
        <GitBranch size={13} /> Run After · {activeCount}
        {policy.enabled && <Percent size={11} color="#d9a76f" aria-label={`Автокомпакт включён при ${policy.percent}%`} />}
      </button>

      {visible && createPortal(<div ref={panelRef} data-global-run-after-panel data-global-run-after-mode={mode}
        onPointerDownCapture={() => { if (mode === 'preview') setMode('pinned'); }}
        style={{ position: 'fixed', zIndex: 15000, left: position.left, top: position.top, width: position.width,
          height: position.height, boxSizing: 'border-box', visibility: pickingRewind ? 'hidden' : 'visible', display: 'flex',
          flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'visible', background: '#181818', color: '#ccc',
          border: `1px solid ${mode === 'pinned' ? 'rgba(255,255,255,0.34)' : '#414141'}`, borderRadius: 9,
          padding: '18px 9px 8px', fontSize: 12, boxShadow: '0 12px 35px #0008' }}>
        <div data-global-run-after-pages style={{ position: 'absolute', top: 0, left: 12, transform: 'translateY(-50%)',
          display: 'inline-flex', gap: 4, alignItems: 'center', padding: '0 4px', background: '#181818', zIndex: 3 }}>
          <button type="button" className="gra-page" onClick={() => switchPage('queues')} aria-pressed={page === 'queues'}
            style={{ ...button, height: 28, padding: '0 9px', color: page === 'queues' ? '#e6bb8b' : '#929297',
              borderColor: page === 'queues' ? '#79583b' : '#363636' }}>Очереди · {activeCount}</button>
          <button type="button" className="gra-page" onClick={() => switchPage('compact')} aria-pressed={page === 'compact'}
            style={{ ...button, height: 28, padding: '0 9px', color: page === 'compact' ? '#e6bb8b' : '#929297',
              borderColor: page === 'compact' ? '#79583b' : '#363636' }}>
            Автокомпакт{policy.enabled ? ` · ≥${policy.percent}%` : ''}
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: page === 'compact' ? 'auto' : 'hidden', scrollbarGutter: 'stable' }}>
          {page === 'compact' ? <AutoCompactPage inventory={inventory} busy={busy} /> :
            <QueueOverview inventory={inventory} queues={queues} busy={busy} selectedId={selectedId}
              setSelectedId={setSelectedId} beforeCloseRef={beforeCloseRef} onRewindTargetModeChange={setPickingRewind} />}
        </div>

        <div data-global-run-after-resize="right" onPointerDown={(event) => startResize('right', event)}
          style={{ position: 'absolute', top: 10, right: -4, bottom: 14, width: 8, cursor: 'ew-resize', zIndex: 2 }} />
        <div data-global-run-after-resize="bottom" onPointerDown={(event) => startResize('bottom', event)}
          style={{ position: 'absolute', left: 10, right: 14, bottom: -4, height: 8, cursor: 'ns-resize', zIndex: 2 }} />
        <div data-global-run-after-resize="corner" onPointerDown={(event) => startResize('corner', event)} title="Изменить размер"
          style={{ position: 'absolute', right: -3, bottom: -3, width: 15, height: 15, cursor: 'nwse-resize', zIndex: 4,
            background: 'linear-gradient(135deg, transparent 52%, rgba(255,255,255,0.22) 53%, rgba(255,255,255,0.22) 61%, transparent 62%, transparent 72%, rgba(255,255,255,0.16) 73%, rgba(255,255,255,0.16) 80%, transparent 81%)',
            borderRadius: '0 0 8px 0' }} />

        <style>{`
          .gra-control, .gra-choice, .gra-page, .gra-node-action {
            transition: filter 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
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
      </div>, document.body)}
    </>
  );
}
