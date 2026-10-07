import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Folder, ChevronDown, Plus } from 'lucide-react';
import { useOutlineDnd, type OutlineDndNode, type OutlineDndCommitPayload } from '@noted/structured-dnd/react';
import TabCard from './TabCard';
import { openTabContextMenuAt, TAB_RENAME_REQUEST_EVENT } from './TabBar';
import type { LinkedFile } from './TabLinkedFiles';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { startTabSidebarResize } from '../../utils/tabSidebarResize';
import { beginPaneTabDrag, endPaneTabDrag, resolvePaneTabDropTarget,
  setPaneTabDragTarget, type PaneTabDropTarget, type PaneTabDragEntry } from '../../utils/paneTabDragBridge';
import { subscribePaneTabPointerDrop } from '../../utils/paneTabPointerBridge';
import { selectWorkflowReserve, workflowReserveOutline, reserveNodeEntries, reservePaneEntries, workflowGroupKey } from '../../utils/workflowReserve.mjs';
import { getTabChromeColorConfig } from './tabChrome';
import { tabOutlineHorizontalPolicy, tabOutlineVerticalSlotPolicy } from './tabOutlineModel.mjs';
import type { SharedTabActivityMaps } from './TabSignals';
import './WorkflowTabSidebar.css';

export type WorkflowReserveState = {
  openProjects: Map<string, any>;
  tabWorkflowMembership: Record<string, { workflowId: string; revision: number }>;
  spaces: Array<{ id: string; name: string; kind?: 'user' | 'inbox'; layout?: any }>;
  activeSpaceId: string;
  splitPanes?: any[];
  centerStrips?: Record<string, any[]>;
  activeSpaceTab?: { projectId: string; tabId: string } | null;
  windowDisplayLayouts?: Record<string, any>;
  globalGroups?: any;
  tabCatalog?: Record<string,any>;
};
type Node = OutlineDndNode & { projectId: string; tabId?: string; groupId?: string; label?: string; children: Node[];
  contextParent?: { projectId: string; tabId: string; name: string } | null };
export type ReserveDropRequest = {
  workflowId: string;
  entries: PaneTabDragEntry[];
  beforeTabId?: string;
  group?: { projectId: string; groupId: string };
  expectedMembership: WorkflowReserveState['tabWorkflowMembership'];
};
export interface WorkflowTabSidebarProps {
  /** Parent supplies the canonical catalog/membership and effective layout. */
  state: WorkflowReserveState;
  orderedTabIds?: string[];
  selectedTabIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onOpenTab: (projectId: string, tabId: string) => Promise<boolean> | boolean;
  onOpenFile: (ownerProjectId: string, file: LinkedFile) => void;
  onCreateTab: (request: { workflowId: string; sourceTabId?: string; cwd?: string; placement: 'reserve' }) => Promise<unknown>;
  onCreateGroup: (workflowId: string) => void;
  onGroupContextMenu: (projectId: string, groupId: string, x: number, y: number) => void;
  /** Projected subset only! Parent merges into complete order/groups/links. */
  onCommitOutline: (request: { workflowId: string; payload: OutlineDndCommitPayload<Node>;
    expectedMembership: WorkflowReserveState['tabWorkflowMembership'] }) => Promise<boolean> | boolean;
  onPlaceTabs: (entries: PaneTabDragEntry[], target: PaneTabDropTarget,
    expectedMembership: WorkflowReserveState['tabWorkflowMembership']) => Promise<boolean> | boolean;
  onDetachTabs: (request: ReserveDropRequest) => Promise<boolean> | boolean;
  sourceTabId?: string;
  fallbackCwd?: string;
  sharedActivity?: SharedTabActivityMaps;
  scrollTop?: number;
  onScrollOffsetChange?: (workflowId: string, top: number) => void;
}

function ReserveCard({ node, rowProps, selected, activity, onClick, onOpenFile }: {
  node: Node; rowProps: any; selected: boolean; activity?: SharedTabActivityMaps;
  onClick: (event: React.MouseEvent) => void; onOpenFile: (file: LinkedFile) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null), ref = useRef<HTMLElement | null>(null);
  const host = `workflow-reserve:${node.projectId}:${node.tabId}`;
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.host !== host || detail?.tabId !== node.tabId) return;
      setDraft(useWorkspaceStore.getState().openProjects.get(node.projectId)?.tabs.get(node.tabId!)?.name || '');
    };
    window.addEventListener(TAB_RENAME_REQUEST_EVENT, listener);
    return () => window.removeEventListener(TAB_RENAME_REQUEST_EVENT, listener);
  }, [host, node.projectId, node.tabId]);
  const menu = (x: number, y: number) => openTabContextMenuAt(node.projectId, node.tabId!, x, y,
    { renameHost: host, singleTarget: true,
      isCurrent: () => !!ref.current?.isConnected && !!useWorkspaceStore.getState().openProjects.get(node.projectId)?.tabs.has(node.tabId!) });
  const commit = () => {
    const name = draft?.trim(); setDraft(null);
    if (name) useWorkspaceStore.getState().renameTab(node.projectId, node.tabId!, name);
  };
  return <TabCard {...rowProps} ref={element => { ref.current = element; rowProps.ref(element); }}
    projectId={node.projectId} tabId={node.tabId!} as="span" fullWidth reserveSignalSpace
    sharedActivity={activity} selected={selected} interactiveStatus
    tabIndex={0} role="button" aria-label={node.label} aria-pressed={selected}
    data-workflow-reserve-tab={node.tabId} data-execution-namespace={node.projectId}
    onLinkedFileOpen={onOpenFile} onClick={event => { if (draft === null) onClick(event); }}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); menu(event.clientX, event.clientY); }}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.click(); }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); menu(rect.left + 12, rect.bottom);
      }
      if (event.key === 'F2') { event.preventDefault(); setDraft(node.label || ''); }
    }}>
    {draft === null ? <span className="workflow-reserve-label">{node.label}</span> : <input data-no-drag
      aria-label="Название вкладки" autoFocus value={draft} onClick={event => event.stopPropagation()}
      onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => {
        event.stopPropagation(); if (event.key === 'Enter') commit(); if (event.key === 'Escape') setDraft(null);
      }} />}
  </TabCard>;
}

/** One scroll owner and no terminal/History children. Lifetime stays in Root. */
export default function WorkflowTabSidebar(props: WorkflowTabSidebarProps) {
  const { state } = props, workflowId = state.activeSpaceId;
  const width = useUIStore(ui => ui.tabSidebarWidth);
  const model = useMemo(() => selectWorkflowReserve(state, workflowId, props.orderedTabIds),
    [state, workflowId, props.orderedTabIds]);
  const outline = useMemo(() => workflowReserveOutline(model) as Node[], [model]);
  const sidebar = useRef<HTMLDivElement>(null), latest = useRef(props), anchor = useRef('');
  latest.current = props;
  const stopResize = useRef<(() => void) | null>(null);
  const [creating, setCreating] = useState(false), [error, setError] = useState('');
  const dnd = useOutlineDnd<Node>({ outline, layoutAnimation: false,
    ignoreSelector: 'input,button,[data-no-drag],[data-tab-linked-files]',
    onCommit: payload => latest.current.onCommitOutline({ workflowId, payload, expectedMembership: state.tabWorkflowMembership }),
    onToggle: ({ nodeId }) => {
      const node = indexNodes(outline).get(String(nodeId));
      if (node?.groupId && state.globalGroups) {
        const group = state.globalGroups.groups.find((group:any) => group.id === node.groupId);
        if (group) void useWorkspaceStore.getState().mutateWorkflowGroup('collapse',{version:1,mutationId:crypto.randomUUID(),
          expectedRevision:state.globalGroups.revision,groupId:group.id,expectedGroupRevision:group.revision,collapsed:!group.collapsed})
          .catch(error => setError(String(error)));
      } else if (node?.groupId) useWorkspaceStore.getState().toggleTabGroupCollapsed(node.projectId, node.groupId);
    },
    canHorizontalMove: payload => {
      const { sourceNode } = payload;
      // Physical subagents/files keep exact ownership. Organizational visual
      // parents may move through the existing structured hierarchy resolver.
      if (sourceNode.groupId) return false;
      const owner = model.catalog.get(sourceNode.tabId);
      if (owner?.tab.parentTabId || owner?.tab.tabType === 'file') return false;
      return tabOutlineHorizontalPolicy(payload);
    },
    canUseVerticalSlot: payload => {
      if (!tabOutlineVerticalSlotPolicy(payload)) return false;
      const owner = model.catalog.get(payload.sourceNode.tabId);
      if (!owner?.tab.parentTabId && owner?.tab.tabType !== 'file') return true;
      // A reorder must not become an unlink/rebind of a real child or file.
      return outlineParent(outline, String(payload.sourceNode.id)) === payload.slot.parentId;
    },
    resolveExternalTarget: ({ clientX, clientY, sourceNode }) => resolvePaneTabDropTarget(
      document.elementFromPoint(clientX, clientY), clientX, reservePaneEntries(model, sourceNode, props.selectedTabIds).map((entry: PaneTabDragEntry) => entry.tabId), clientY),
    onExternalCommit: payload => latest.current.onPlaceTabs(reservePaneEntries(model, payload.sourceNode, latest.current.selectedTabIds),
      payload.externalTarget as PaneTabDropTarget, state.tabWorkflowMembership),
  });
  const nodes = indexNodes(dnd.previewOutline);
  useEffect(() => {
    const drag = dnd.dragState, node = drag && nodes.get(String(drag.sourceId));
    if (!node || drag?.phase !== 'dragging') return;
    const entries = reservePaneEntries(model, node, latest.current.selectedTabIds);
    if (!entries.length) return;
    const rootTabId = entries[0].tabId;
    beginPaneTabDrag({ owner: 'sidebar', rootTabId, entries, sourceSpaceId: workflowId });
    setPaneTabDragTarget((drag.externalTarget as PaneTabDropTarget) || null);
    return () => endPaneTabDrag(rootTabId);
  }, [dnd.dragState?.sessionId, dnd.dragState?.phase, dnd.dragState?.externalTarget, workflowId]);
  // Existing pane pointer transport ends outside panes without committing a
  // placement. This exact reserve receiver then requests one canonical detach.
  useEffect(() => {
    const unsubscribe = subscribePaneTabPointerDrop(pointer => {
    const pointed = document.elementFromPoint(pointer.clientX, pointer.clientY) as HTMLElement | null;
    if (!sidebar.current?.contains(pointed) || !pointer.source?.entries.length) return;
    const current = latest.current;
    const tab = pointed?.closest<HTMLElement>('[data-workflow-reserve-tab]');
    const group = pointed?.closest<HTMLElement>('[data-reserve-group-id]');
    Promise.resolve(current.onDetachTabs({ workflowId: current.state.activeSpaceId,
      entries: pointer.source.entries, beforeTabId: tab?.dataset.workflowReserveTab,
      group: group ? { projectId: group.dataset.executionNamespace!, groupId: group.dataset.reserveGroupId! } : undefined,
      expectedMembership: current.state.tabWorkflowMembership })).catch(reason => setError(String(reason)));
    });
    return () => { unsubscribe(); };
  }, []);
  useEffect(() => () => { stopResize.current?.(); }, []);
  useEffect(() => { stopResize.current?.(); dnd.cancel('workflow-changed'); anchor.current = ''; }, [workflowId]);
  const userScroll = useRef(false);
  useLayoutEffect(() => {
    const scroller = dnd.scrollerRef.current; if (!scroller) return;
    userScroll.current = false;
    const apply = () => {
      if (!userScroll.current) scroller.scrollTop = Math.min(props.scrollTop || 0, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
    };
    apply(); const observer = new ResizeObserver(apply);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => observer.disconnect();
  }, [workflowId]);
  const select = (id: string, event: React.MouseEvent) => {
    const current = latest.current, ids = model.reserve.map((owner: any) => owner.tabId);
    if (event.shiftKey && anchor.current && ids.includes(anchor.current)) {
      const a = ids.indexOf(anchor.current), b = ids.indexOf(id);
      current.onSelectionChange(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); return;
    }
    anchor.current = id;
    if (event.metaKey || event.ctrlKey) {
      current.onSelectionChange(current.selectedTabIds.includes(id)
        ? current.selectedTabIds.filter(candidate => candidate !== id) : [...current.selectedTabIds, id]); return;
    }
    current.onSelectionChange([id]);
    const owner = model.catalog.get(id);
    Promise.resolve(current.onOpenTab(owner.projectId, id)).catch(reason => setError(String(reason)));
  };
  const create = async () => {
    if (creating) return;
    setCreating(true); setError('');
    const source = model.catalog.get(props.sourceTabId);
    try { await props.onCreateTab({ workflowId, sourceTabId: source?.tabId,
      cwd: source?.tab.cwd || props.fallbackCwd, placement: 'reserve' }); }
    catch (reason) { setError(String(reason)); } finally { setCreating(false); }
  };
  return <div ref={sidebar} data-tab-sidebar data-workflow-tab-sidebar={workflowId}
    data-keyboard-focus-surface="sidebar" className="workflow-tab-sidebar" style={{width,zIndex:1}}
    onPointerDownCapture={event => {
      if (event.button === 0 && !(event.target as Element).closest('[data-tab-sidebar-resize-handle],[data-tab-context-menu]'))
        useUIStore.getState().setActiveArea('sidebar');
    }}>
    <div className="workflow-reserve-toolbar"><span>Резерв <small>{model.reserve.length}</small></span>
      <button aria-label="Создать группу" title="Создать группу" onClick={() => props.onCreateGroup(workflowId)}><Folder size={14} /></button>
      <button aria-label="Новая вкладка в резерве" title="Новая вкладка" disabled={creating} onClick={create}><Plus size={16} /></button>
    </div>
    {error && <div role="alert" className="workflow-reserve-error">{error}</div>}
    <div ref={element => { dnd.scrollerRef.current = element; }} data-workflow-reserve-scroll
      className="workflow-reserve-scroll" onWheel={() => { userScroll.current = true; }}
      onPointerDown={() => { userScroll.current = true; }}
      onScroll={event => { if (userScroll.current) props.onScrollOffsetChange?.(workflowId, event.currentTarget.scrollTop); }}>
      <div className="workflow-reserve-outline">
        {dnd.rows.map(row => {
          const node = nodes.get(String(row.id))!;
          const rowProps = dnd.getRowProps(row);
          const group = node.groupId && model.visibleGroups.get(workflowGroupKey(node.projectId, node.groupId));
          const color = group && getTabChromeColorConfig(group);
          return <div key={row.id} className="workflow-reserve-row" style={{ paddingLeft: row.depth * 14 }}>
            {node.groupId ? <div {...rowProps} className="workflow-reserve-group" style={color ? { background: color.bgColor, borderColor: color.borderColor } : undefined} data-reserve-group-id={node.groupId}
              data-execution-namespace={node.projectId} onContextMenu={event => {
                event.preventDefault(); props.onGroupContextMenu(node.projectId, node.groupId!, event.clientX, event.clientY);
              }}><button aria-label={`${row.expanded ? 'Свернуть' : 'Раскрыть'} группу ${node.label}`}
                onClick={() => dnd.requestExpansion(row.id, !row.expanded)}><ChevronDown size={14} style={{ transform: row.expanded ? undefined : 'rotate(-90deg)' }} /></button>
              <Folder size={16} /><span>{node.label}</span><small>{reserveNodeEntries(node).length}</small></div>
              : <><ReserveCard node={node} rowProps={rowProps} selected={props.selectedTabIds.includes(node.tabId!)}
                activity={props.sharedActivity} onClick={event => select(node.tabId!, event)}
                onOpenFile={file => props.onOpenFile(node.projectId, file)} />
                {!!node.contextParent && <div className="workflow-reserve-parent" title={node.contextParent.name}>↳ {node.contextParent.name}</div>}</>}
          </div>;
        })}
        {!model.reserve.length && <div className="workflow-reserve-empty">Все вкладки размещены в окнах</div>}
        <div {...dnd.scrollSpacerProps} />
      </div>
    </div>
    <div data-tab-sidebar-resize-handle onPointerDown={event => {
      if (event.button !== 0) return;
      stopResize.current?.(); stopResize.current = startTabSidebarResize(event, {
        getWidth: () => useUIStore.getState().tabSidebarWidth,
        commitWidth: value => useUIStore.getState().setTabSidebarWidth(value),
        subscribeCancel: cancel => useUIStore.subscribe((next, previous) => {
          if (next.activeDisplayKey !== previous.activeDisplayKey || next.tabSidebarWidth !== previous.tabSidebarWidth) cancel();
        }), onFinish: () => { stopResize.current = null; },
      });
    }} />
  </div>;
}

function indexNodes(outline: Node[]) {
  const index = new Map<string, Node>();
  const walk = (nodes: Node[]) => nodes.forEach(node => { index.set(String(node.id), node); walk(node.children || []); });
  walk(outline); return index;
}

function outlineParent(outline: Node[], id: string, parent: string | number | null = null): string | number | null | undefined {
  for (const node of outline) {
    if (String(node.id) === id) return parent;
    const found = outlineParent(node.children || [], id, node.id);
    if (found !== undefined) return found;
  }
  return undefined;
}
