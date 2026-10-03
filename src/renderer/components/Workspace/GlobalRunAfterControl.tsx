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
  Eye,
  EyeOff,
  GitBranch,
  Pause,
  Percent,
  Play,
  Power,
  Repeat2,
  RotateCw,
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
import { summarizeRunningAutoCompacts } from '../../utils/autoCompactActivityPresentation.mjs';
import WorkflowChip from './WorkflowChip';
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
import { retainPanelPosition, scrollMovesAnchor } from '../../utils/anchoredPanelPosition.mjs';
import ControlHint from '../UI/ControlHint';
import { PromptQueueOverlay } from './PromptQueueOverlay';
import { TabPaneMap } from './PaneMap';
import { TabProcessBar } from './TabSignals';
import { adjustRgbaAlpha, flattenRgbaOnTabbarPanel, getTabChromeColorConfig } from './tabChrome';

const PANEL_MARGIN = 8;
// Page controls straddle the top frame by 14px. The full gap therefore owns
// that outside half instead of letting it overlap the navigation row.
const PANEL_GAP = 17;
const PANEL_MIN_W = 520;
const PANEL_DEFAULT_W = 760;
const PANEL_DEFAULT_H = 600;
const GRAPH_NODE_W = 270;
const FLOATING_QUEUE_MIN_W = 168;
const FLOATING_QUEUE_MAX_W = 600;
const FLOATING_QUEUE_MAX_H = 430;
const GLOBAL_PANEL_SIZE_KEY = 'noted-terminal-global-run-after-size';

type GlobalPanelSize = { width: number; height: number; heightFixed: boolean };
type QueueEditorState = { tabId: string; mode: 'preview' | 'pinned' };

function queueHoverSatelliteRects(root: HTMLElement | null): DOMRect[] {
  const owner = root?.querySelector<HTMLElement>('[data-prompt-queue-hover-owner]')?.dataset.promptQueueHoverOwner;
  if (!owner) return [];
  // An overlay covering the viewport is click dismissal, not hover territory.
  // Nor can a popup belonging to another local/global queue hold this one open.
  return Array.from(document.querySelectorAll<HTMLElement>('[data-run-after-hover-owner]'))
    .filter((element) => element.dataset.runAfterHoverOwner === owner)
    .map((element) => element.getBoundingClientRect());
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
      // Values saved by the first implementation had a mandatory 600px
      // height. Treat that legacy shape as a ceiling, not an intentional fixed
      // empty canvas. Only a new vertical resize opts into fixed height.
      heightFixed: parsed.heightFixed === true,
    };
  } catch {
    return { width: PANEL_DEFAULT_W, height: PANEL_DEFAULT_H, heightFixed: false };
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
  const afterRestart = head?.trigger?.kind === 'app-restart';
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
      {afterRestart && <RotateCw size={10} color="#a78bfa" aria-label="После перезапуска приложения" />}
      {queue.loopPromptEnabled && <Repeat2 size={10} color="#a78bfa" aria-label="Loop включён" />}
      {activityMessage && <Percent size={10} color="#d5b48b" aria-label={activityMessage} />}
    </span>
  );
}

function QueueTabNode({ tab, queue, busy, selected, onEdit, onPreview }: {
  tab: AutomationTab;
  queue?: TabQueue;
  busy: boolean;
  selected: boolean;
  onEdit: () => void;
  onPreview: (event: React.MouseEvent) => void;
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
  const tabBackground = flattenRgbaOnTabbarPanel(resolveTabCardBackground(
    { bgColor: chrome.bgColor, hasColor, active, hovered, selected },
    adjustRgbaAlpha,
  ));
  const count = queue ? countEnabledQueuedPrompts(queue.items) : 0;
  const runAppearance = resolveRunAfterPlayAppearance({
    autoRun: queue?.autoRun === true,
    activeItemCount: count,
    firstChipArmedHint: queue?.firstChipHintActive === true,
    hovered: runHovered,
  });

  const navigate = () => {
    // Ordinary click follows the tab's existing placement, just like the
    // sidebar and Ctrl+Tab. Only an unplaced tab may use the focused window;
    // middle-click/Cmd+click below remain the explicit "move/add here" gesture.
    useWorkspaceStore.getState().placeTab(tab.projectId, tab.id);
    useUIStore.getState().setActiveArea('workspace');
    requestTabPrimaryInputFocus(tab.id, 'global-run-after-tab');
  };

  const placeHere = (event: React.MouseEvent) => {
    const cmdClick = event.button === 0
      && event.metaKey
      && !event.ctrlKey
      && !event.altKey
      && !event.shiftKey;
    if (event.button !== 1 && !cmdClick) return;
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
        gap: 4,
        zIndex: 2,
        borderRadius: metrics.borderRadius,
      }}
    >
      <span
        data-global-run-after-project-icon={tab.projectId}
        title={tab.projectName}
        aria-hidden
        style={{
          width: 12,
          flex: '0 0 12px',
          display: 'grid',
          placeItems: 'center',
          alignSelf: 'center',
          marginRight: 2,
        }}
      >
        {tab.projectIcon ? (
          <img src={tab.projectIcon} alt="" draggable={false}
            style={{ width: 12, height: 12, borderRadius: 2, objectFit: 'cover' }} />
        ) : (
          <span style={{ width: 12, height: 12, borderRadius: 2, boxSizing: 'border-box',
            border: '1px dashed rgba(148,163,184,0.8)', background: 'rgba(148,163,184,0.08)' }} />
        )}
      </span>
      <button
        type="button"
        data-global-run-after-tab-chip={tab.id}
        onClick={(event) => {
          if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
            placeHere(event);
            return;
          }
          navigate();
        }}
        onAuxClick={placeHere}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={`${tab.name} · ${tab.projectName}\nКлик — перейти; Cmd+клик или средний клик — поместить в текущее окно`}
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
          // Match the visible PaneTabChip: project identity is its sibling and
          // the tab itself is an unframed opaque-composited colour surface.
          border: 'none',
          background: tabBackground,
          boxShadow: selected ? 'inset 0 0 0 1px rgba(255,255,255,0.28)' : undefined,
        }}
      >
        <TabProcessBar hasProcess={false} busy={busy} inheritedBusy={false} radius={metrics.borderRadius} zIndex={1} />
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
              onMouseEnter={onPreview}
              onClick={onEdit}
              style={{
                ...button,
                width: 26,
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
                width: 26,
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

function QueueDependencyMap({ inventory, queues, busy, selectedId, onSelect, onPreview }: {
  inventory: ReturnType<typeof useAutomationInventory>;
  queues: Map<string, TabQueue>;
  busy: Map<string, boolean>;
  selectedId: string | null;
  onSelect: (tabId: string) => void;
  onPreview: (tabId: string, event: React.MouseEvent) => void;
}) {
  const tabGeo = useUIStore((state) => state.tabGeometry);
  const tabsFontSize = useUIStore((state) => state.tabsFontSize);
  // resolveTabCardBoxHeight reserves 2px for a border. The visible window chip
  // is borderless, so graph geometry removes exactly that reserve: 22.8px at
  // the current 14px/3px settings instead of our previous 26px row.
  const nodeHeight = Math.max(1, resolveTabCardBoxHeight(tabGeo, { fontSize: tabsFontSize }) - 2);
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
                    selected={selectedId === tab.id} onEdit={() => onSelect(tab.id)} onPreview={(event) => onPreview(tab.id, event)} />
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

function AutoCompactPage({ inventory, busy }: {
  inventory: ReturnType<typeof useAutomationInventory>;
  busy: Map<string, boolean>;
}) {
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

function QueueOverview({
  inventory,
  queues,
  busy,
  editorState,
  setEditorState,
  beforeCloseRef,
  onRewindTargetModeChange,
  pickingRewind,
  editorGestureActive,
  onHoverGestureChange,
  geometryKey,
}: {
  inventory: ReturnType<typeof useAutomationInventory>;
  queues: Map<string, TabQueue>;
  busy: Map<string, boolean>;
  editorState: QueueEditorState | null;
  setEditorState: (state: QueueEditorState | null) => void;
  beforeCloseRef: { current: (reason?: 'outside') => boolean };
  onRewindTargetModeChange: (active: boolean) => void;
  pickingRewind: boolean;
  editorGestureActive: boolean;
  onHoverGestureChange: (active: boolean, point: { clientX: number; clientY: number } | null) => void;
  geometryKey: string;
}) {
  const [showDisabled, setShowDisabled] = useState(false);
  const [editorPosition, setEditorPosition] = useState({
    left: PANEL_MARGIN,
    top: 80 as number | null,
    bottom: null as number | null,
    width: FLOATING_QUEUE_MAX_W,
    maxHeight: FLOATING_QUEUE_MAX_H,
  });
  const editorPopoverRef = useRef<HTMLDivElement>(null);
  const editorPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const relayEditorGesture = useCallback((active: boolean, point: { clientX: number; clientY: number } | null) => {
    editorPointerRef.current = point;
    onHoverGestureChange(active, point);
  }, [onHoverGestureChange]);
  const tabGeo = useUIStore((state) => state.tabGeometry);
  const tabsFontSize = useUIStore((state) => state.tabsFontSize);
  const promptQueueWidth = useUIStore((state) => state.promptQueueWidth);
  const disabledNodeHeight = Math.max(1, resolveTabCardBoxHeight(tabGeo, { fontSize: tabsFontSize }) - 2);
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
  const selectedId = editorState?.tabId || null;
  const selectedTab = selectedId ? inventory.tabs.find((tab) => tab.id === selectedId) : undefined;
  const selectedQueue = selectedId ? queues.get(selectedId) : undefined;

  const preview = useCallback((tabId: string, event: React.MouseEvent) => {
    if (editorState?.mode === 'pinned') return;
    if (editorState?.tabId !== tabId && !beforeCloseRef.current()) return;
    editorPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    setEditorState({ tabId, mode: 'preview' });
  }, [beforeCloseRef, editorState, setEditorState]);

  const select = useCallback((tabId: string) => {
    if (editorState?.tabId === tabId && editorState.mode === 'pinned') {
      if (beforeCloseRef.current()) setEditorState(null);
      return;
    }
    if (editorState?.tabId !== tabId && !beforeCloseRef.current()) return;
    setEditorState({ tabId, mode: 'pinned' });
  }, [beforeCloseRef, editorState, setEditorState]);

  const toggleDisabled = useCallback(() => {
    const hidesEditorTrigger = showDisabled
      && !!selectedId
      && disabledTabs.some((tab) => tab.id === selectedId);
    if (hidesEditorTrigger && !beforeCloseRef.current()) return;
    if (hidesEditorTrigger) setEditorState(null);
    setShowDisabled((value) => !value);
  }, [beforeCloseRef, disabledTabs, selectedId, setEditorState, showDisabled]);

  useLayoutEffect(() => {
    if (!editorState) return;
    const measure = () => {
      const trigger = document.querySelector<HTMLElement>(
        `[data-global-run-after-editor-trigger="${CSS.escape(editorState.tabId)}"]`,
      );
      if (!trigger?.isConnected) {
        setEditorState(null);
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const ownerRect = trigger.closest<HTMLElement>('[data-global-run-after-node]')?.getBoundingClientRect() || rect;
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const width = Math.min(
        Math.max(FLOATING_QUEUE_MIN_W, Math.min(FLOATING_QUEUE_MAX_W, promptQueueWidth)),
        Math.max(FLOATING_QUEUE_MIN_W, viewportW - PANEL_MARGIN * 2),
      );
      // Align to the entire owner node, not the count alone. Otherwise the next
      // row's Play sat just outside the popup and visually became its button.
      const left = clamp(ownerRect.right - width, PANEL_MARGIN, viewportW - width - PANEL_MARGIN);
      // Border-mounted controls occupy the popup's own top edge. A tiny seam is
      // enough; the previous 15px gap broke the visible ownership link.
      const gap = 3;
      const belowTop = ownerRect.bottom + gap;
      const belowSpace = viewportH - belowTop - PANEL_MARGIN;
      const aboveSpace = ownerRect.top - gap - PANEL_MARGIN;
      const openBelow = belowSpace >= Math.min(190, Math.max(0, aboveSpace));
      const maxHeight = Math.max(100, Math.min(
        FLOATING_QUEUE_MAX_H,
        openBelow ? belowSpace : aboveSpace,
      ));
      const next = {
        left,
        top: openBelow ? belowTop : null,
        bottom: openBelow ? null : viewportH - ownerRect.top + gap,
        width,
        maxHeight,
      };
      setEditorPosition((previous) => (
        previous.left === next.left
        && previous.top === next.top
        && previous.bottom === next.bottom
        && previous.width === next.width
        && previous.maxHeight === next.maxHeight
          ? previous
          : next
      ));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    const trigger = document.querySelector<HTMLElement>(
      `[data-global-run-after-editor-trigger="${CSS.escape(editorState.tabId)}"]`,
    );
    if (trigger) observer?.observe(trigger);
    const onAncestorScroll = (event: Event) => {
      if (!trigger?.isConnected || scrollMovesAnchor(event.target, trigger)) measure();
    };
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', onAncestorScroll, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', onAncestorScroll, true);
    };
  }, [editorState, geometryKey, inventory.tabs.length, promptQueueWidth, queues, setEditorState, showDisabled]);

  useEffect(() => {
    if (editorState?.mode !== 'preview') return;
    const recheck = (point: { clientX: number; clientY: number } | null) => {
      if (pickingRewind || editorGestureActive) return;
      const hub = editorPopoverRef.current?.getBoundingClientRect() || null;
      const trigger = document.querySelector<HTMLElement>(
        `[data-global-run-after-editor-trigger="${CSS.escape(editorState.tabId)}"]`,
      )?.getBoundingClientRect() || null;
      const satellites = [trigger, ...queueHoverSatelliteRects(editorPopoverRef.current)];
      if (point && pointInHoverCluster({ hub, satellites, x: point.clientX, y: point.clientY, pad: 2 })) return;
      if (!beforeCloseRef.current('outside')) return;
      setEditorState(null);
    };
    const onMove = (event: MouseEvent) => {
      editorPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      recheck(event);
    };
    const onExitWindow = () => { editorPointerRef.current = null; recheck(null); };
    const onMouseOut = (event: MouseEvent) => { if (!event.relatedTarget) onExitWindow(); };
    recheck(editorPointerRef.current);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseout', onMouseOut);
    window.addEventListener('blur', onExitWindow);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseout', onMouseOut);
      window.removeEventListener('blur', onExitWindow);
    };
  }, [beforeCloseRef, editorGestureActive, editorState, pickingRewind, setEditorState]);

  return (
    <div data-global-run-after-queues style={{ minHeight: 0 }}>
      <div data-global-run-after-map-scroll
        style={{ minHeight: 0, overflowX: 'auto', overflowY: 'hidden', padding: '2px 2px 9px' }}>
        <QueueDependencyMap inventory={inventory} queues={queues} busy={busy} selectedId={selectedId}
          onSelect={select} onPreview={preview} />

        {!!disabledTabs.length && <div style={{ marginTop: 8, borderTop: '1px solid #2e2e2e', paddingTop: 7 }}>
          <button type="button" className="gra-control" aria-expanded={showDisabled} onClick={toggleDisabled}
            style={{ ...button, height: 25, display: 'inline-flex', alignItems: 'center', gap: 5, color: '#8f8f95' }}>
            {showDisabled ? <EyeOff size={12} /> : <Eye size={12} />} Выключенные · {disabledTabs.length}
          </button>
          {showDisabled && <div data-global-run-after-disabled style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 7 }}>
            {disabledTabs.map((tab) => <div key={tab.id} style={{ width: GRAPH_NODE_W, height: disabledNodeHeight }}>
              <QueueTabNode tab={tab} queue={queues.get(tab.id)} busy={busy.get(tab.id) === true}
                selected={selectedId === tab.id} onEdit={() => select(tab.id)} onPreview={(event) => preview(tab.id, event)} />
            </div>)}
          </div>}
        </div>}
      </div>

      {editorState && selectedTab && selectedQueue && createPortal(
        <div
          ref={editorPopoverRef}
          data-global-run-after-floating-editor={selectedTab.id}
          data-global-run-after-editor-mode={editorState.mode}
          data-run-after-satellite="true"
          style={{
            position: 'fixed',
            left: editorPosition.left,
            ...(editorPosition.top === null ? { bottom: editorPosition.bottom ?? PANEL_MARGIN } : { top: editorPosition.top }),
            width: editorPosition.width,
            maxHeight: editorPosition.maxHeight,
            paddingTop: 11,
            // Embedded queue satellites use 15100+. Keep the shell below them
            // while still above the 15000 global overview.
            zIndex: 15050,
            boxSizing: 'border-box',
            pointerEvents: 'auto',
            filter: 'drop-shadow(0 12px 24px rgba(0,0,0,0.46))',
          }}
        >
          <PromptQueueOverlay
            tabId={selectedTab.id}
            sessionType={selectedTab.provider}
            agentBusy={busy.get(selectedTab.id) === true}
            inputSurface="history"
            embedded
            embeddedPinned={editorState.mode === 'pinned'}
            embeddedWidth={editorPosition.width}
            embeddedMaxHeight={Math.max(90, editorPosition.maxHeight - 11)}
            beforeCloseRef={beforeCloseRef}
            onRewindTargetModeChange={onRewindTargetModeChange}
            onHoverGestureChange={relayEditorGesture}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}

export function GlobalRunAfterControl() {
  const [mode, setMode] = useState<'hidden' | 'preview' | 'pinned'>('hidden');
  const [page, setPage] = useState<'queues' | 'compact'>('queues');
  const [editorState, setEditorState] = useState<QueueEditorState | null>(null);
  const [pickingRewind, setPickingRewind] = useState(false);
  const [editorGestureActive, setEditorGestureActive] = useState(false);
  const [panelSize, setPanelSize] = useState(loadPanelSize);
  const [position, setPosition] = useState({ left: PANEL_MARGIN, top: 65, width: PANEL_DEFAULT_W, height: PANEL_DEFAULT_H });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelContentRef = useRef<HTMLDivElement>(null);
  const beforeCloseRef = useRef<(reason?: 'outside') => boolean>(() => true);
  const resizeActiveRef = useRef(false);
  const editorGestureActiveRef = useRef(false);
  const previewPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
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
  const closePanel = useCallback((reason?: 'outside') => {
    // Hover dismissal is an editor exit too. Blur fields before unmount so
    // threshold/timer edits take the same save path as an ordinary blur.
    const active = document.activeElement;
    const floatingEditor = editorState?.tabId ? document.querySelector<HTMLElement>(
      `[data-global-run-after-floating-editor="${CSS.escape(editorState.tabId)}"]`,
    ) : null;
    if (active instanceof HTMLElement && (panelRef.current?.contains(active) || floatingEditor?.contains(active))) {
      active.blur();
    }
    if (!beforeCloseRef.current(reason)) return false;
    setEditorState(null);
    setMode('hidden');
    return true;
  }, [editorState?.tabId]);
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
      const width = Math.min(panelSize.width, maxW);
      const left = clamp(rect.left, PANEL_MARGIN, viewportW - width - PANEL_MARGIN);
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
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', onAncestorScroll, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', onAncestorScroll, true);
    };
  }, [panelSize, sidebarWidth, visible]);

  const recheckPreviewHover = useCallback((point: { clientX: number; clientY: number } | null) => {
    if (mode !== 'preview' || pickingRewind || editorGestureActive || resizeActiveRef.current) return;
    if (!point) { closePanel(); return; }
    const panelRect = panelRef.current?.getBoundingClientRect() || null;
    const floatingEditor = editorState?.tabId ? document.querySelector<HTMLElement>(
      `[data-global-run-after-floating-editor="${CSS.escape(editorState.tabId)}"]`,
    ) : null;
    const satelliteRects = [triggerRef.current?.getBoundingClientRect() || null,
      ...Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
        '[data-global-run-after-pages], [data-global-run-after-resize]',
      ) || []).map((element) => element.getBoundingClientRect()),
      floatingEditor?.getBoundingClientRect() || null,
      ...queueHoverSatelliteRects(floatingEditor)];
    if (pointInHoverCluster({ hub: panelRect, satellites: satelliteRects, x: point.clientX, y: point.clientY, pad: 2 })) return;
    closePanel();
  }, [closePanel, editorGestureActive, editorState?.tabId, mode, pickingRewind]);
  const recheckPreviewHoverRef = useRef(recheckPreviewHover);
  recheckPreviewHoverRef.current = recheckPreviewHover;
  useEffect(() => {
    if (mode !== 'preview') return;
    const onMove = (event: MouseEvent) => {
      previewPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      recheckPreviewHover(event);
    };
    const onExitWindow = () => { previewPointerRef.current = null; recheckPreviewHover(null); };
    const onMouseOut = (event: MouseEvent) => { if (!event.relatedTarget) onExitWindow(); };
    // Rewind temporarily hides the surface, not its ownership. Once target
    // selection ends, recheck the real last pointer even without a new move.
    recheckPreviewHover(previewPointerRef.current);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseout', onMouseOut);
    window.addEventListener('blur', onExitWindow);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseout', onMouseOut);
      window.removeEventListener('blur', onExitWindow);
    };
  }, [mode, recheckPreviewHover]);

  const { start: startResizeGesture } = usePointerGesture();
  const startResize = useCallback((edge: 'right' | 'bottom' | 'corner', event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
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
          : clamp(startWidth + moveEvent.clientX - startX, Math.min(PANEL_MIN_W, maxWidth), maxWidth);
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
            panelRef.current.style.height = panelSize.heightFixed ? `${position.height}px` : 'auto';
            panelRef.current.style.maxHeight = `${position.height}px`;
          }
          if (panelContentRef.current) {
            panelContentRef.current.style.maxHeight = panelSize.heightFixed
              ? 'none'
              : `${Math.max(90, position.height - 26)}px`;
          }
          recheckAfterGesture();
          return;
        }
        setPanelSize({
          width: nextWidth,
          height: nextHeight,
          heightFixed: panelSize.heightFixed || edge !== 'right',
        });
        recheckAfterGesture();
      },
    });
    resizeActiveRef.current = true;
  }, [panelSize, position, startResizeGesture]);

  const switchPage = (next: 'queues' | 'compact') => {
    if (next === page) return;
    if (!beforeCloseRef.current()) return;
    setEditorState(null);
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
        <GitBranch size={13} /> run-after · {activeCount}
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
            style={{ position: 'fixed', zIndex: 15000, left: position.left, top: position.top, width: position.width,
              height: panelSize.heightFixed ? position.height : 'auto', maxHeight: position.height,
              boxSizing: 'border-box', visibility: pickingRewind ? 'hidden' : 'visible', display: 'flex',
              flexDirection: 'column', minWidth: 0, minHeight: 0, overflow: 'visible', background: '#181818', color: '#ccc',
              border: `1px solid ${mode === 'pinned' ? 'rgba(255,255,255,0.34)' : '#414141'}`, borderRadius: 9,
              padding: '18px 9px 8px', fontSize: 12, boxShadow: '0 12px 35px #0008' }}>
        <div data-global-run-after-pages style={{ position: 'absolute', top: 0, left: 12, transform: 'translateY(-50%)',
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
        </div>

        <div ref={panelContentRef} style={{ flex: panelSize.heightFixed ? 1 : '0 1 auto', minHeight: 0,
          maxHeight: panelSize.heightFixed ? 'none' : Math.max(90, position.height - 26),
          overflow: 'auto', scrollbarGutter: 'stable' }}>
          {page === 'compact' ? <AutoCompactPage inventory={inventory} busy={busy} /> :
            <QueueOverview inventory={inventory} queues={queues} busy={busy} editorState={editorState}
              setEditorState={setEditorState} beforeCloseRef={beforeCloseRef}
              onRewindTargetModeChange={setPickingRewind}
              pickingRewind={pickingRewind}
              editorGestureActive={editorGestureActive}
              onHoverGestureChange={handleEditorGesture}
              geometryKey={`${position.left}:${position.top}:${position.width}:${position.height}`} />}
        </div>

        <div data-global-run-after-resize="right" onPointerDown={(event) => startResize('right', event)}
          style={{ position: 'absolute', top: 10, right: -4, bottom: 14, width: 8, cursor: 'ew-resize',
            userSelect: 'none', touchAction: 'none', zIndex: 2 }} />
        <div data-global-run-after-resize="bottom" onPointerDown={(event) => startResize('bottom', event)}
          style={{ position: 'absolute', left: 10, right: 14, bottom: -4, height: 8, cursor: 'ns-resize',
            userSelect: 'none', touchAction: 'none', zIndex: 2 }} />
        <div data-global-run-after-resize="corner" onPointerDown={(event) => startResize('corner', event)} title="Изменить размер"
          style={{ position: 'absolute', right: -3, bottom: -3, width: 15, height: 15, cursor: 'nwse-resize',
            userSelect: 'none', touchAction: 'none', zIndex: 4,
            background: 'linear-gradient(135deg, transparent 52%, rgba(255,255,255,0.22) 53%, rgba(255,255,255,0.22) 61%, transparent 62%, transparent 72%, rgba(255,255,255,0.16) 73%, rgba(255,255,255,0.16) 80%, transparent 81%)',
            borderRadius: '0 0 8px 0' }} />

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
