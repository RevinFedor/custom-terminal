import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Folder, Hourglass, LoaderCircle, Pencil, Play, X } from 'lucide-react';
import { useWorkspaceStore, type TabColor, type TabGroup } from '../../store/useWorkspaceStore';
import { useProjectsStore } from '../../store/useProjectsStore';
import { useUIStore } from '../../store/useUIStore';
import { useOrchestrationStore } from '../../store/useOrchestrationStore';
import { getBusyTabsSnapshot } from '../../hooks/usePromptQueueRunner';
import { resolveRunAfterTabStatus } from '../../utils/runAfterTabStatus.mjs';
import { aiKindForTab, runAfterWorkflowByProject } from '../../utils/runAfterTabScope.mjs';
import { canonicalRunAfterPickerInventory } from '../../utils/runAfterPickerInventory.mjs';
import { getRestartAfterTriggerIds } from '../../utils/restartAfterCommand.mjs';
import { resolveAgentBusyPresentation } from '../../utils/agentBusyPresentation.mjs';
import {
  UNPLACED_WORKFLOW_ID,
  UNPLACED_WORKFLOW_NAME,
  resolveWorkflowIcon,
} from '../../utils/workflowVisuals.mjs';
import ControlHint from '../UI/ControlHint';
import TabCard from './TabCard';
import WorkflowChipPresentation, { WORKFLOW_ICON_CHIP_WIDTH } from './WorkflowChip';
import { CONTEXT_MENU_ICON_SLOT_STYLE, CONTEXT_MENU_ROW_STYLE } from '../UI/contextMenuMetrics.mjs';
import { pointInHoverCluster } from '../../utils/hoverBridge.mjs';
import { markQueueChildDismiss, notifyQueueClickChildClosed } from '../../utils/hoverReturnGate.mjs';
import {
  TabProcessBar,
  TabStatusMarker,
} from './TabSignals';

const { ipcRenderer } = window.require('electron');

// Shared picker used by:
// - PromptQueueOverlay: "Run after" selects the AI tab that should trigger queue continuation.
// - TabBar context menu: "Restart after" selects the AI tab whose loader completion restarts a terminal tab.
//
// Keep this component free of prompt-queue or tab-context-menu store writes. Callers own persistence
// through setRunAfterTab so the same workflow/tab inventory and busy-state UI can be reused safely.

const DEEP_PULSE = '#8b5cf6';
const PULSE = '#a78bfa';
const TABBAR_PANEL_RGB = { r: 37, g: 37, b: 38 };
const TABBAR_PANEL_BG = `rgb(${TABBAR_PANEL_RGB.r}, ${TABBAR_PANEL_RGB.g}, ${TABBAR_PANEL_RGB.b})`;
const BORDER = 'rgba(255,255,255,0.08)';
const TEXT_MUTED = '#888';
const TEXT_DIM = '#555';
const FLOATING_OVERLAY_Z_INDEX = 130;
const HOVER_CLOSE_TOLERANCE = 4;

const TAB_COLORS: { color: TabColor; bgColor: string; borderColor: string }[] = [
  { color: 'default', bgColor: 'transparent', borderColor: '#666' },
  { color: 'red', bgColor: 'rgba(239, 68, 68, 0.2)', borderColor: 'rgb(239, 68, 68)' },
  { color: 'yellow', bgColor: 'rgba(234, 179, 8, 0.2)', borderColor: 'rgb(234, 179, 8)' },
  { color: 'green', bgColor: 'rgba(34, 197, 94, 0.2)', borderColor: 'rgb(34, 197, 94)' },
  { color: 'blue', bgColor: 'rgba(59, 130, 246, 0.2)', borderColor: 'rgb(59, 130, 246)' },
  { color: 'purple', bgColor: 'rgba(168, 85, 247, 0.2)', borderColor: 'rgb(168, 85, 247)' },
  { color: 'claude', bgColor: 'rgba(218, 119, 86, 0.2)', borderColor: '#DA7756' },
  { color: 'gemini', bgColor: 'rgba(78, 134, 248, 0.2)', borderColor: '#4E86F8' },
  { color: 'codex', bgColor: 'rgba(16, 163, 127, 0.18)', borderColor: '#10A37F' },
];

type AiTabKind = 'claude-pty' | 'claude-sdk' | 'gemini' | 'codex';

const AI_KIND_COLOR: Record<AiTabKind, string> = {
  'claude-pty': '#DA7756',
  'claude-sdk': '#D28C5A',
  gemini: '#4E86F8',
  codex: '#10A37F',
};

type AiTab = {
  id: string;
  name: string;
  kind: AiTabKind;
  projectId: string;
  color?: TabColor;
  tabType?: string;
  groupId?: string;
  visualParentTabId?: string;
  sessionStatus?: string;
  commandType?: string;
  cwd?: string;
  claudeSessionId?: string;
  codexSessionId?: string;
  geminiSessionId?: string;
};

type AiWorkflowGroup = {
  workflowId: string;
  name: string;
  icon: string | null;
  unplaced: boolean;
  isOwnerWorkflow: boolean;
  tabs: AiTab[];
  rows: PickerRow[];
};

type PickerRow =
  | { type: 'tab'; tab: AiTab; index: number }
  | { type: 'group'; projectId: string; group: TabGroup; tabs: AiTab[]; index: number };

type PickerAnchor = {
  top: number;
  width: number;
  left?: number;
  right?: number;
  maxHeight: number;
};

type TabRuntimeStatus = 'busy' | 'inherited' | 'waiting' | 'idle';

export type RunAfterTabPickerProps = {
  tabId: string;
  autoRun: boolean;
  runAfterTabId: string | null;
  runAfterTabIds?: string[];
  runAfterWorkflowIds?: string[];
  /** Restart after only: caller persists a live subscription to this workflow. */
  onToggleAllTabs?: (workflowId: string) => void;
  waitingTabIds?: ReadonlySet<string>;
  setRunAfterTab: (tabId: string, target: string | null) => void;
  panelRef: RefObject<HTMLDivElement | null>;
  hoverOwner?: string;
  ownerProjectId?: string | null;
  title?: string;
  emptyLabel?: string;
  showAllTabsOnOpen?: boolean;
  /**
   * Run after only. Two OPPOSITE contracts for two neighbouring controls:
   *   • the show-all counter resets to off on every open — it answers "show me
   *     more right now", a one-off action;
   *   • the selected workflow persists in the DB and changes ONLY when a chip is
   *     clicked — it answers "I work over here", a standing context. It used to
   *     be re-derived on open, so moving to another workflow silently changed
   *     the user's choice.
   * The same picker serves Link File / Restart after / Git, which must keep
   * their current behaviour — hence a flag from the caller, not a hardcode.
   */
  persistProjectSelection?: boolean;
  triggerVariant?: 'pill' | 'context-row';
  triggerLabel?: string;
  triggerIcon?: ReactNode;
  menuWidth?: number;
  /** Compact Run After scope: complete workflow inventory, including Inbox. */
  workflowIconsOnly?: boolean;
  zIndex?: number;
  side?: 'left' | 'right';
  accentColor?: string;
  accentTextColor?: string;
  showRuntimeDot?: boolean;
  showTargetSummary?: boolean;
  openOnHover?: boolean;
  onTriggerClick?: () => boolean | void;
  multiSelect?: boolean;
  closeOnSelect?: boolean;
  hideTrigger?: boolean;
  externalTriggerRef?: RefObject<HTMLElement | null>;
  openRequestKey?: number;
  /**
   * A programmatic open request is a one-shot command owned by the caller.
   * A picker can unmount with its parent panel, so remembering the consumed key
   * in a local ref is not enough: the caller must retire the command after the
   * menu has actually opened.
   */
  onOpenRequestConsumed?: (key: number) => void;
  closeRequestKey?: number;
  modalOverlay?: boolean;
  /** A surrounding row may already own the clear action. */
  showPillClearAction?: boolean;
  /** In the overview a visible target is navigation; pencil/ПКМ changes it. */
  navigateOnPillClick?: boolean;
  showTaskMarkers?: boolean;
};

const adjustRgbaAlpha = (rgba: string, delta: number): string => {
  const m = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),?\s*([\d.]+)?\)/);
  if (!m) return rgba;
  const [, r, g, b, a = '0.2'] = m;
  const nextAlpha = Math.max(0, Math.min(1, parseFloat(a) + delta));
  return `rgba(${r}, ${g}, ${b}, ${nextAlpha})`;
};

const flattenRgbaOnTabbarPanel = (color: string): string => {
  if (color === 'transparent') return TABBAR_PANEL_BG;
  const m = color.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,?\s*([\d.]+))?\s*\)/);
  if (!m) return color;
  const [, rText, gText, bText, aText] = m;
  const alpha = aText === undefined ? 1 : Math.max(0, Math.min(1, parseFloat(aText)));
  const r = Number(rText);
  const g = Number(gText);
  const b = Number(bText);
  if (alpha >= 1) return `rgb(${r}, ${g}, ${b})`;
  const blend = (fg: number, bg: number) => Math.round((fg * alpha) + (bg * (1 - alpha)));
  return `rgb(${blend(r, TABBAR_PANEL_RGB.r)}, ${blend(g, TABBAR_PANEL_RGB.g)}, ${blend(b, TABBAR_PANEL_RGB.b)})`;
};

const pickerGroupBackground = (group: TabGroup, hover: boolean): string => {
  const groupColor = group.color && group.color !== 'default' ? group.color : undefined;
  const colorConfig = TAB_COLORS.find((c) => c.color === groupColor);
  if (colorConfig) {
    return flattenRgbaOnTabbarPanel(adjustRgbaAlpha(colorConfig.bgColor, hover ? 0.10 : -0.06));
  }
  return flattenRgbaOnTabbarPanel(hover || group.collapsed ? 'rgba(139,92,246,0.13)' : 'rgba(255,255,255,0.035)');
};

function orderTabsWithVisualChildren(tabs: AiTab[]): AiTab[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const childrenByParent = new Map<string, AiTab[]>();
  const roots: AiTab[] = [];

  for (const tab of tabs) {
    const parentId = tab.visualParentTabId;
    if (!parentId || parentId === tab.id || !byId.has(parentId)) {
      roots.push(tab);
      continue;
    }
    const children = childrenByParent.get(parentId) || [];
    children.push(tab);
    childrenByParent.set(parentId, children);
  }

  const ordered: AiTab[] = [];
  const seen = new Set<string>();
  const visit = (tab: AiTab) => {
    if (seen.has(tab.id)) return;
    seen.add(tab.id);
    ordered.push(tab);
    for (const child of childrenByParent.get(tab.id) || []) visit(child);
  };

  for (const tab of roots) visit(tab);
  for (const tab of tabs) visit(tab);
  return ordered;
}

function buildPickerRows(
  tabs: AiTab[],
  tabGroupsByProject: Map<string, TabGroup[]>,
): PickerRow[] {
  const rows: PickerRow[] = [];
  const groupByKey = new Map<string, TabGroup>();
  for (const [projectId, groups] of tabGroupsByProject) {
    for (const group of groups) groupByKey.set(`${projectId}:${group.id}`, group);
  }
  const renderedGroups = new Set<string>();
  const tabsByGroup = new Map<string, AiTab[]>();

  for (const tab of tabs) {
    const groupKey = tab.groupId && groupByKey.has(`${tab.projectId}:${tab.groupId}`)
      ? `${tab.projectId}:${tab.groupId}`
      : undefined;
    if (!groupKey) continue;
    const groupTabs = tabsByGroup.get(groupKey) || [];
    groupTabs.push(tab);
    tabsByGroup.set(groupKey, groupTabs);
  }

  for (const tab of tabs) {
    const groupKey = tab.groupId && groupByKey.has(`${tab.projectId}:${tab.groupId}`)
      ? `${tab.projectId}:${tab.groupId}`
      : undefined;
    if (!groupKey) {
      rows.push({ type: 'tab', tab, index: rows.length });
      continue;
    }
    if (renderedGroups.has(groupKey)) continue;
    const group = groupByKey.get(groupKey)!;
    renderedGroups.add(groupKey);
    rows.push({
      type: 'group',
      projectId: tab.projectId,
      group,
      tabs: tabsByGroup.get(groupKey) || [],
      index: rows.length,
    });
  }

  return rows;
}

export function RunAfterTabPicker({
  tabId,
  autoRun,
  runAfterTabId,
  runAfterTabIds,
  runAfterWorkflowIds = [],
  onToggleAllTabs,
  waitingTabIds,
  setRunAfterTab,
  panelRef,
  hoverOwner,
  ownerProjectId: ownerProjectIdProp = null,
  title = 'Run after - pick a tab',
  emptyLabel = 'on tab',
  showAllTabsOnOpen = false,
  persistProjectSelection = false,
  triggerVariant = 'pill',
  triggerLabel = 'Run after',
  triggerIcon = null,
  menuWidth = 252,
  workflowIconsOnly = false,
  zIndex = FLOATING_OVERLAY_Z_INDEX,
  side = 'left',
  accentColor = '#10A37F',
  accentTextColor = '#a7f3d0',
  showRuntimeDot = true,
  showTargetSummary = true,
  openOnHover = false,
  onTriggerClick,
  multiSelect = false,
  closeOnSelect = true,
  hideTrigger = false,
  externalTriggerRef,
  openRequestKey = 0,
  onOpenRequestConsumed,
  closeRequestKey = 0,
  modalOverlay = false,
  showPillClearAction = true,
  navigateOnPillClick = false,
  showTaskMarkers = true,
}: RunAfterTabPickerProps) {
  const toggleTabGroupCollapsed = useWorkspaceStore((state) => state.toggleTabGroupCollapsed);
  const sessionStatuses = useUIStore((state) => state.sessionStatuses);
  const tabGeo = useUIStore((state) => state.tabGeometry);
  const tabsFontSize = useUIStore((state) => state.tabsFontSize);
  const explicitInputIds = useMemo(() => {
    const raw = multiSelect && Array.isArray(runAfterTabIds)
      ? runAfterTabIds
      : (runAfterTabId ? [runAfterTabId] : []);
    return Array.from(new Set(raw
      .map((id) => typeof id === 'string' ? id.trim() : '')
      .filter((id) => id.length > 0)));
  }, [multiSelect, runAfterTabId, runAfterTabIds]);
  const selectedWorkflowKey = runAfterWorkflowIds.join('|');
  const projectIconFingerprint = useProjectsStore((state) => Object.entries(state.projects)
    .map(([projectId, project]) => `${projectId}:${project.icon || ''}`)
    .sort()
    .join('|'));

  const fingerprint = useWorkspaceStore((state) => {
    let ownerProjectId: string | null = null;
    const parts: string[] = ['owner:',`organization:${state.organizationReady}:${state.globalGroups?.revision ?? ''}:${state.runAfterWorkflowScopeVersions?.[tabId] ?? ''}`];
    for (const [pid, ws] of state.openProjects) {
      if (ws.tabs.has(tabId) || pid === ownerProjectIdProp) ownerProjectId = pid;
      const projectBits: string[] = [pid, ws.projectPath || ''];
      for (const group of ws.tabGroups || []) {
        projectBits.push([
          'g',
          group.id,
          group.name || '',
          group.collapsed ? 1 : 0,
          group.color || '',
          group.sessionStatus || '',
          group.anchorTabId || '',
        ].join(':'));
      }
      for (const t of ws.tabs.values()) {
        if (t.parentTabId) continue;
        const kind = aiKindForTab(t);
        if (!kind) continue;
        projectBits.push([
          't',
          t.id,
          t.name || '',
          kind,
          t.color || '',
          t.tabType || '',
          t.groupId || '',
          t.visualParentTabId || '',
          t.sessionStatus || '',
          t.commandType || '',
          t.cwd || '',
          t.claudeSessionId || '',
          t.codexSessionId || '',
          t.geminiSessionId || '',
          state.tabWorkflowMembership?.[t.id]?.workflowId || '',
          state.tabWorkflowMembership?.[t.id]?.revision ?? '',
          state.tabCatalog?.[t.id]?.active===false ? 'inactive' : '',
        ].join(':'));
      }
      parts.push(projectBits.join('~'));
    }
    for (const space of state.spaces) {
      parts.push([
        'w',
        space.id,
        space.name || '',
        space.icon || '',
        JSON.stringify((space as any).reserveOrder || []),
        JSON.stringify((space as any).reserveRootOrder || []),
        ...(Array.isArray(space.projectIds) ? space.projectIds : []),
      ].join(':'));
    }
    parts[0] = 'owner:' + (ownerProjectId || '');
    return parts.join('|');
  });

  const selectedInputIds = useMemo(() => getRestartAfterTriggerIds({
    id: tabId, restartAfterTabIds: explicitInputIds,
    restartAfterWorkflowIds: multiSelect ? runAfterWorkflowIds : [],
  }, useWorkspaceStore.getState()), [fingerprint, tabId, explicitInputIds, multiSelect, selectedWorkflowKey]);
  const selectedInputKey = selectedInputIds.join('|');

  const inventory = useMemo<{
    groups: AiWorkflowGroup[];
    ownerWorkflowId: string | null;
    selectedTargetWorkflowId: string | null;
  }>(() => {
    if (!fingerprint) return { groups: [], ownerWorkflowId: null, selectedTargetWorkflowId: null };
    const state = useWorkspaceStore.getState();
    const projects = useProjectsStore.getState().projects;
    if(state.organizationReady)return canonicalRunAfterPickerInventory(state,{
      ownerTabId:tabId,selectedTabIds:selectedInputIds,selectedWorkflowIds:runAfterWorkflowIds,projects,
      includeEmptyWorkflows:workflowIconsOnly});
    const allTabsById = new Map<string, AiTab>();
    const allTabsByProject = new Map<string, AiTab[]>();
    const tabGroupsByProject = new Map<string, TabGroup[]>();
    let ownerProjectId: string | null = ownerProjectIdProp;

    for (const [projectId, ws] of state.openProjects) {
      if (ws.tabs.has(tabId)) ownerProjectId = projectId;
      tabGroupsByProject.set(projectId, ws.tabGroups || []);
      const projectTabs: AiTab[] = [];
      for (const t of ws.tabs.values()) {
        if (t.parentTabId) continue;
        const kind = aiKindForTab(t);
        if (!kind) continue;
        const tab: AiTab = {
          id: t.id,
          name: t.name || t.id.slice(-6),
          kind,
          projectId,
          color: t.color,
          tabType: t.tabType,
          groupId: t.groupId,
          visualParentTabId: t.visualParentTabId,
          sessionStatus: t.sessionStatus,
          commandType: t.commandType,
          cwd: t.cwd,
          claudeSessionId: t.claudeSessionId,
          codexSessionId: t.codexSessionId,
          geminiSessionId: t.geminiSessionId,
        };
        allTabsById.set(t.id, tab);
        projectTabs.push(tab);
      }
      allTabsByProject.set(projectId, orderTabsWithVisualChildren(projectTabs));
    }

    // Workflow membership is project metadata, not current window placement.
    // A project has one workflow parent; every one of its sidebar tabs belongs
    // to that workflow even if it is not currently shown in a pane.
    const workflowByProjectId = runAfterWorkflowByProject(state.spaces);
    const ownerWorkflowId = ownerProjectId
      ? workflowByProjectId.get(ownerProjectId) || UNPLACED_WORKFLOW_ID
      : UNPLACED_WORKFLOW_ID;
    const firstSelectedTargetId = selectedInputIds.find((id) => allTabsById.has(id)) || null;
    const selectedTargetProjectId = firstSelectedTargetId
      ? allTabsById.get(firstSelectedTargetId)?.projectId || null
      : null;
    const selectedTargetWorkflowId = firstSelectedTargetId
      ? (selectedTargetProjectId
        ? workflowByProjectId.get(selectedTargetProjectId) || UNPLACED_WORKFLOW_ID
        : UNPLACED_WORKFLOW_ID)
      : (runAfterWorkflowIds[0] || null);
    const placedProjectIds = new Set<string>();
    const groups: AiWorkflowGroup[] = [];

    for (const space of state.spaces) {
      const workflowProjectIds = (Array.isArray(space.projectIds) ? space.projectIds : [])
        // Legacy duplicates fail closed to the first workflow in strip order,
        // matching the one-parent contract used by Settings.
        .filter((projectId) => workflowByProjectId.get(projectId) === space.id);
      workflowProjectIds.forEach((projectId) => placedProjectIds.add(projectId));
      const orderedTabs = workflowProjectIds.flatMap(
        (projectId) => allTabsByProject.get(projectId) || [],
      );
      if (!workflowIconsOnly && orderedTabs.length === 0 && space.id !== ownerWorkflowId && !runAfterWorkflowIds.includes(space.id)) continue;
      groups.push({
        workflowId: space.id,
        name: space.name || 'Workflow',
        icon: resolveWorkflowIcon(space, (projectId: string) => projects[projectId]?.icon || null),
        unplaced: false,
        isOwnerWorkflow: space.id === ownerWorkflowId,
        tabs: orderedTabs,
        rows: buildPickerRows(orderedTabs, tabGroupsByProject),
      });
    }

    const unplacedTabs = orderTabsWithVisualChildren(
      Array.from(allTabsByProject.entries())
        .filter(([projectId]) => !placedProjectIds.has(projectId))
        .flatMap(([, tabs]) => tabs),
    );
    if (unplacedTabs.length > 0 || ownerWorkflowId === UNPLACED_WORKFLOW_ID || runAfterWorkflowIds.includes(UNPLACED_WORKFLOW_ID)) {
      groups.push({
        workflowId: UNPLACED_WORKFLOW_ID,
        name: UNPLACED_WORKFLOW_NAME,
        icon: null,
        unplaced: true,
        isOwnerWorkflow: ownerWorkflowId === UNPLACED_WORKFLOW_ID,
        tabs: unplacedTabs,
        rows: buildPickerRows(unplacedTabs, tabGroupsByProject),
      });
    }

    return { groups, ownerWorkflowId, selectedTargetWorkflowId };
  }, [fingerprint, projectIconFingerprint, tabId, selectedInputKey, selectedWorkflowKey, workflowIconsOnly]);

  const [busyMap, setBusyMap] = useState<Map<string, boolean>>(() => getBusyTabsSnapshot());
  // Which tabs are working right now, app-wide. A STRING, not a Set: a selector
  // that builds a collection allocates a new one on every store write and would
  // re-render this menu constantly (the fingerprint rule above does the same).
  const storeBusyKey = useWorkspaceStore((state) => {
    const ids: string[] = [];
    for (const ws of state.openProjects.values()) {
      for (const t of ws.tabs.values()) if (t.aiBusy) ids.push(t.id);
    }
    return ids.join('|');
  });
  const storeBusyIds = useMemo(
    () => new Set(storeBusyKey ? storeBusyKey.split('|') : []),
    [storeBusyKey],
  );
  const inheritedBusyTabIds = useOrchestrationStore((state) => state.inheritedBusyTabIds);
  useEffect(() => {
    setBusyMap(getBusyTabsSnapshot());

    const apply = (tid: string, busy: boolean) =>
      setBusyMap((prev) => {
        if (prev.get(tid) === busy) return prev;
        const next = new Map(prev);
        next.set(tid, busy);
        return next;
      });

    const handleClaudeBusy = (_: unknown, data: { tabId: string; busy: boolean; reason?: string; activityBusy?: boolean }) => {
      const { tabId: tid, reason } = data;
      if (reason === 'spinner') return;
      apply(tid, resolveAgentBusyPresentation(data));
    };
    const handleGeminiBusy = (_: unknown, { tabId: tid, busy }: { tabId: string; busy: boolean }) => apply(tid, busy);
    const handleCodexBusy = (_: unknown, { tabId: tid, busy }: { tabId: string; busy: boolean }) => apply(tid, busy);

    ipcRenderer.on('claude:busy-state', handleClaudeBusy);
    ipcRenderer.on('gemini:busy-state', handleGeminiBusy);
    ipcRenderer.on('codex:busy-state', handleCodexBusy);
    return () => {
      ipcRenderer.removeListener('claude:busy-state', handleClaudeBusy);
      ipcRenderer.removeListener('gemini:busy-state', handleGeminiBusy);
      ipcRenderer.removeListener('codex:busy-state', handleCodexBusy);
    };
  }, []);

  const [open, setOpen] = useState(false);
  const wasClickOpenRef = useRef(false);
  const dismissRef = useRef<{ reason: string; point: { clientX: number; clientY: number } | null } | null>(null);
  useLayoutEffect(() => {
    const held = open && !openOnHover && !!hoverOwner;
    if (wasClickOpenRef.current && !held) {
      notifyQueueClickChildClosed(hoverOwner, dismissRef.current?.reason || 'selection', dismissRef.current?.point || null);
    }
    wasClickOpenRef.current = held;
    if (held) dismissRef.current = null;
  }, [open, openOnHover, hoverOwner]);
  // The persisted storage key keeps its legacy "Project" name for migration;
  // its value is a workflow id from this version onward.
  const persistedPickerWorkflowId = useUIStore((state) => state.runAfterPickerProjectId);
  const setPersistedPickerWorkflowId = useUIStore((state) => state.setRunAfterPickerProjectId);
  const [localSelectedWorkflowId, setLocalSelectedWorkflowId] = useState<string | null>(null);
  const selectedWorkflowId = persistProjectSelection ? persistedPickerWorkflowId : localSelectedWorkflowId;
  const setSelectedWorkflowId = useCallback((workflowId: string | null) => {
    if (persistProjectSelection) setPersistedPickerWorkflowId(workflowId);
    else setLocalSelectedWorkflowId(workflowId);
  }, [persistProjectSelection, setPersistedPickerWorkflowId]);
  const [showAllTabs, setShowAllTabs] = useState(showAllTabsOnOpen);
  const [countHover, setCountHover] = useState(false);
  const [triggerHover, setTriggerHover] = useState(false);
  const [pillActionHover, setPillActionHover] = useState<'navigate' | 'clear' | null>(null);
  const [portalContainer] = useState(() => {
    const el = document.createElement('div');
    el.dataset.runAfterPickerPortal = 'true';
    return el;
  });
  const [anchor, setAnchor] = useState<PickerAnchor | null>(null);
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = externalTriggerRef || internalTriggerRef;
  const menuRef = useRef<HTMLDivElement>(null);
  const workflowStripRef = useRef<HTMLDivElement>(null);
  const lastOpenRequestKeyRef = useRef(0);
  const lastCloseRequestKeyRef = useRef(0);

  useEffect(() => {
    document.body.appendChild(portalContainer);
    return () => {
      if (portalContainer.parentNode) {
        portalContainer.parentNode.removeChild(portalContainer);
      }
    };
  }, [portalContainer]);

  useEffect(() => {
    // Only a workflow that no longer exists may be replaced. A remembered choice
    // that is still open stays selected — that is the whole contract.
    const exists = selectedWorkflowId && inventory.groups.some((g) => g.workflowId === selectedWorkflowId);
    if (exists) return;
    const preferred=[inventory.selectedTargetWorkflowId,inventory.ownerWorkflowId]
      .find(id=>id && inventory.groups.some(group=>group.workflowId===id));
    setSelectedWorkflowId(preferred ?? inventory.groups[0]?.workflowId ?? null);
  }, [inventory.groups, inventory.ownerWorkflowId, inventory.selectedTargetWorkflowId, selectedWorkflowId, setSelectedWorkflowId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      dismissRef.current = { reason: 'outside', point: { clientX: e.clientX, clientY: e.clientY } };
      markQueueChildDismiss(e, hoverOwner);
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismissRef.current = { reason: 'escape', point: null };
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !openOnHover) return;
    let frame = 0;
    const onMove = (e: MouseEvent) => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const triggerRect = triggerRef.current?.getBoundingClientRect();
        const menuRect = menuRef.current?.getBoundingClientRect();
        if (!triggerRect || !menuRect) return;
        // Список и его кнопка плюс зазор между ними — одно целое. Сторона не
        // задаётся: список раскрывается влево или вправо в зависимости от места
        // у края экрана, а зазор всегда лежит там, где блоки разошлись.
        if (pointInHoverCluster({
          hub: menuRect,
          satellites: [triggerRect],
          x: e.clientX,
          y: e.clientY,
          pad: HOVER_CLOSE_TOLERANCE,
        })) return;
        setOpen(false);
      });
    };
    window.addEventListener('mousemove', onMove, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('mousemove', onMove, true);
    };
  }, [open, openOnHover]);

  const naturalMenuWidth = workflowIconsOnly
    ? Math.max(menuWidth, 18 + inventory.groups.length * WORKFLOW_ICON_CHIP_WIDTH + Math.max(0, inventory.groups.length - 1) * 4)
    : menuWidth;
  const positionMenu = useCallback((): boolean => {
    const panelRect = panelRef.current?.getBoundingClientRect() ?? null;
    const triggerRect = triggerRef.current?.getBoundingClientRect() ?? null;
    const useTriggerRect = !!externalTriggerRef || triggerVariant === 'context-row';
    const verticalRect = useTriggerRect && triggerRect ? triggerRect : panelRect;
    const horizontalRect = externalTriggerRef && triggerRect ? triggerRect : (panelRect ?? triggerRect);
    if (!verticalRect || !horizontalRect) return false;
    const top = Math.max(8, verticalRect.top);
    const width = Math.min(naturalMenuWidth, Math.max(1, window.innerWidth - 16));
    const nextAnchor: PickerAnchor = {
      top,
      width,
      maxHeight: Math.max(180, window.innerHeight - top - 8),
    };
    const leftSide = horizontalRect.left - width - 6;
    const rightSide = horizontalRect.right + 6;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    let left = side === 'right' ? rightSide : leftSide;
    if (side === 'left' && leftSide < 8) left = rightSide;
    if (side === 'right' && rightSide > maxLeft && leftSide >= 8) left = leftSide;
    nextAnchor.left = Math.max(8, Math.min(maxLeft, left));
    setAnchor(previous => previous && previous.left === nextAnchor.left && previous.top === nextAnchor.top
      && previous.width === nextAnchor.width && previous.maxHeight === nextAnchor.maxHeight ? previous : nextAnchor);
    return true;
  }, [externalTriggerRef, naturalMenuWidth, panelRef, side, triggerRef, triggerVariant]);

  useLayoutEffect(() => {
    if (!open) return;
    positionMenu();
    window.addEventListener('resize', positionMenu);
    return () => window.removeEventListener('resize', positionMenu);
  }, [open, positionMenu]);

  const handleOpen = useCallback((): boolean => {
    if (!positionMenu()) return false;
    // The counter always reopens off; the workflow keeps whatever the user
    // last picked (the effect above still rescues a workflow that closed).
    if (!persistProjectSelection) {
      setSelectedWorkflowId(
        inventory.selectedTargetWorkflowId
        ?? inventory.ownerWorkflowId
        ?? inventory.groups[0]?.workflowId
        ?? null,
      );
    }
    setShowAllTabs(showAllTabsOnOpen);
    setOpen(true);
    return true;
  }, [inventory.groups, inventory.ownerWorkflowId, inventory.selectedTargetWorkflowId, persistProjectSelection, positionMenu, setSelectedWorkflowId, showAllTabsOnOpen]);

  useEffect(() => {
    if (!openRequestKey) return;
    if (lastOpenRequestKeyRef.current === openRequestKey) return;
    if (!handleOpen()) return;
    lastOpenRequestKeyRef.current = openRequestKey;
    onOpenRequestConsumed?.(openRequestKey);
  }, [handleOpen, onOpenRequestConsumed, openRequestKey]);

  useEffect(() => {
    if (!closeRequestKey) return;
    if (lastCloseRequestKeyRef.current === closeRequestKey) return;
    lastCloseRequestKeyRef.current = closeRequestKey;
    setOpen(false);
  }, [closeRequestKey]);

  useEffect(() => {
    if (!open || workflowIconsOnly) return;
    const strip = workflowStripRef.current;
    if (!strip) return;
    // React/Chromium may register delegated wheel handlers as passive. Then a
    // vertical wheel gesture still scrolls the menu/page and native horizontal
    // movement only appears with Shift. Own this small rail directly with a
    // non-passive listener: ordinary wheel/trackpad Y becomes scrollLeft, while
    // a real horizontal gesture keeps its native X delta.
    const onWheel = (event: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;
      if (delta === 0) return;
      const before = strip.scrollLeft;
      strip.scrollLeft += delta;
      if (strip.scrollLeft !== before) event.preventDefault();
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, [open, inventory.groups.length, workflowIconsOnly]);

  const selectedIdSet = useMemo(() => new Set(selectedInputIds), [selectedInputKey]);
  // The rule itself lives in utils/runAfterTabStatus.mjs — this menu is a
  // portal that only exists while open, which made the rule impossible to test
  // where it stood, and it was wrong in exactly the way that only shows up if
  // you catch the app mid-turn.
  const statusFor = (id: string): TabRuntimeStatus => resolveRunAfterTabStatus({
    tabId: id,
    queueBusy: busyMap,
    storeBusy: storeBusyIds,
    inheritedBusy: inheritedBusyTabIds,
    waiting: waitingTabIds ?? null,
    selected: selectedIdSet,
  }) as TabRuntimeStatus;

  const allAiTabs = useMemo(() => inventory.groups.flatMap((g) => g.tabs), [inventory.groups]);
  const selectedTabs = useMemo(() => selectedInputIds
    .map((id) => allAiTabs.find((t) => t.id === id) ?? null)
    .filter((t): t is AiTab => !!t), [allAiTabs, selectedInputKey]);
  const selectedTab = selectedTabs[0] ?? null;
  const selectedTabProjectId = selectedTab?.projectId ?? null;
  const selectedStatus: TabRuntimeStatus | null = selectedTabs.some((t) => statusFor(t.id) === 'busy')
    ? 'busy'
    : selectedTabs.some((t) => statusFor(t.id) === 'inherited')
      ? 'inherited'
      : selectedTabs.some((t) => statusFor(t.id) === 'waiting')
        ? 'waiting'
        : (selectedTab ? 'idle' : null);
  const selectedWorkflow = inventory.groups.find((g) => g.workflowId === selectedWorkflowId) ?? inventory.groups[0] ?? null;
  const targetTabs = selectedWorkflow ? selectedWorkflow.tabs.filter((t) => t.id !== tabId) : [];
  const activeCount = targetTabs.filter((t) => statusFor(t.id) !== 'idle').length;
  const allSelected = !!selectedWorkflow && runAfterWorkflowIds.includes(selectedWorkflow.workflowId);
  const [allHover, setAllHover] = useState(false);

  useEffect(() => {
    if (!open || workflowIconsOnly || !selectedWorkflow?.workflowId) return;
    const frame = requestAnimationFrame(() => {
      const strip = workflowStripRef.current;
      if (!strip || strip.scrollWidth <= strip.clientWidth) return;
      const target = Array.from(strip.querySelectorAll<HTMLElement>('[data-run-after-workflow-chip]'))
        .find((el) => el.dataset.runAfterWorkflowChip === selectedWorkflow.workflowId);
      if (!target) return;
      const centeredLeft = target.offsetLeft + target.offsetWidth / 2 - strip.clientWidth / 2;
      const maxLeft = Math.max(0, strip.scrollWidth - strip.clientWidth);
      strip.scrollLeft = Math.max(0, Math.min(maxLeft, centeredLeft));
    });
    return () => cancelAnimationFrame(frame);
  }, [open, selectedWorkflow?.workflowId, inventory.groups.length, workflowIconsOnly]);

  const isVisibleTab = useCallback((t: AiTab) => {
    if (t.id === tabId) return false;
    return showAllTabs || statusFor(t.id) !== 'idle' || selectedIdSet.has(t.id);
    // storeBusyIds belongs here too: this filter decides which rows are shown
    // at all, so a tab that only the store knows to be working would otherwise
    // stay hidden in the short list until something else re-rendered the menu.
  }, [showAllTabs, tabId, busyMap, storeBusyIds, inheritedBusyTabIds, selectedIdSet, waitingTabIds]);
  const visibleRows = useMemo(() => {
    if (!selectedWorkflow) return [];
    const rows: PickerRow[] = [];
    for (const row of selectedWorkflow.rows) {
      if (row.type === 'tab') {
        if (isVisibleTab(row.tab)) rows.push(row);
        continue;
      }
      const visibleGroupTabs = row.tabs.filter(isVisibleTab);
      if (visibleGroupTabs.length === 0) continue;
      rows.push({ ...row, tabs: visibleGroupTabs });
    }
    return rows;
  }, [isVisibleTab, selectedWorkflow]);

  const hasSelectedTarget = selectedInputIds.length > 0 || (multiSelect && runAfterWorkflowIds.length > 0);
  const selectedSummaryText = multiSelect && runAfterWorkflowIds.length > 0
    ? `All · ${selectedInputIds.length}`
    : multiSelect && selectedInputIds.length > 1
    ? `${selectedInputIds.length} tabs`
    : (selectedTab?.name || (hasSelectedTarget ? 'Missing tab' : emptyLabel));
  const activeTargetWait = hasSelectedTarget && autoRun;
  const triggerBorder = open
    ? 'rgba(190,190,190,0.36)'
    : activeTargetWait
      ? 'rgba(190,190,190,0.28)'
      : hasSelectedTarget
        ? 'rgba(180,180,180,0.24)'
        : BORDER;
  const triggerColor = (hasSelectedTarget || open) ? (activeTargetWait ? '#fff' : '#d8d8d8') : TEXT_MUTED;
  const triggerBg = open
    ? 'rgba(255,255,255,0.08)'
    : activeTargetWait
      ? `${DEEP_PULSE}33`
      : hasSelectedTarget
        ? 'rgba(255,255,255,0.07)'
        : 'transparent';

  const navigateToSelectedTab = useCallback(async () => {
    if (!selectedTab || !selectedTabProjectId) return;
    // Same placement-aware navigation as the sidebar / Ctrl+Tab surfaces. A
    // plain activation would show the tab in the wrong window or workspace.
    if (await useWorkspaceStore.getState().openTabById(selectedTab.id,{projectId:selectedTabProjectId,reason:'run-after-picker'})) setOpen(false);
  }, [selectedTab, selectedTabProjectId]);

  const renderPillTrigger = () => selectedTab ? (
    <PickerTabRow
      buttonRef={internalTriggerRef}
      tab={selectedTab}
      label={selectedSummaryText}
      showTaskMarkers={showTaskMarkers}
      selected
      active={autoRun}
      status={selectedStatus ?? 'idle'}
      sessionStatuses={sessionStatuses}
      tabGeo={tabGeo}
      fontSize={tabsFontSize}
      onClick={event => {
        if (!navigateOnPillClick) { open ? setOpen(false) : handleOpen(); return; }
        if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          event.preventDefault(); event.stopPropagation();
          useWorkspaceStore.getState().placeTab(selectedTab.projectId, selectedTab.id, { mode: 'add-here' });
        } else navigateToSelectedTab();
      }}
      onAuxClick={navigateOnPillClick ? event => {
        if (event.button !== 1) return;
        event.preventDefault(); event.stopPropagation();
        useWorkspaceStore.getState().placeTab(selectedTab.projectId, selectedTab.id, { mode: 'add-here' });
      } : undefined}
      onContextMenu={event => {
        event.preventDefault(); event.stopPropagation(); handleOpen();
      }}
      titleText={
        (autoRun
          ? `Run after ${selectedSummaryText} finishes`
          : `Run after target saved: ${selectedSummaryText} (off)`)
        + (selectedStatus === 'busy'
          ? ' (busy now)'
          : selectedStatus === 'inherited'
            ? ' (child agent is running)'
            : selectedStatus === 'waiting'
              ? ' (waiting for its Run after trigger)'
              : '')
      }
      trailingActions={(
        <>
          <span
            role="button"
            aria-label={navigateOnPillClick ? 'Изменить вкладку ожидания' : `Open ${selectedSummaryText}`}
            title={navigateOnPillClick ? 'Изменить вкладку ожидания' : 'Перейти к вкладке'}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (navigateOnPillClick) handleOpen(); else navigateToSelectedTab();
            }}
            onMouseEnter={() => setPillActionHover('navigate')}
            onMouseLeave={() => setPillActionHover((current) => current === 'navigate' ? null : current)}
            style={{
              width: 16,
              height: 16,
              borderRadius: 4,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              color: pillActionHover === 'navigate' ? '#f3f4f6' : '#8b8b91',
              background: pillActionHover === 'navigate' ? 'rgba(255,255,255,0.12)' : 'transparent',
              cursor: 'pointer',
              transition: 'background 0.12s, color 0.12s',
            }}
          >
            {navigateOnPillClick ? <Pencil size={10} aria-hidden="true" />
              : <Play size={10} strokeWidth={2.2} fill="currentColor" aria-hidden="true" />}
          </span>
          {showPillClearAction && (
            <span
              role="button"
              aria-label="Clear selected Run after tab"
              title="Clear selected tab"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setRunAfterTab(tabId, null);
                setOpen(false);
              }}
              onMouseEnter={() => setPillActionHover('clear')}
              onMouseLeave={() => setPillActionHover((current) => current === 'clear' ? null : current)}
              style={{
                width: 16,
                height: 16,
                borderRadius: 4,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                color: pillActionHover === 'clear' ? '#f3f4f6' : '#77777d',
                background: pillActionHover === 'clear' ? 'rgba(255,255,255,0.12)' : 'transparent',
                cursor: 'pointer',
                transition: 'background 0.12s, color 0.12s',
              }}
            >
              <X size={10} strokeWidth={2.4} aria-hidden="true" />
            </span>
          )}
        </>
      )}
    />
  ) : (
    <button
      ref={internalTriggerRef}
      onClick={() => open ? setOpen(false) : handleOpen()}
      onMouseEnter={() => setTriggerHover(true)}
      onMouseLeave={() => setTriggerHover(false)}
      title={
        hasSelectedTarget
          ? (
            autoRun
              ? `Run after ${selectedSummaryText} finishes`
              : `Run after target saved: ${selectedSummaryText} (off)`
          ) + (selectedStatus === 'busy'
            ? ' (busy now)'
            : selectedStatus === 'inherited'
              ? ' (child agent is running)'
              : selectedStatus === 'waiting'
                ? ' (waiting for its Run after trigger)'
                : '')
          : 'Pick a tab to wait on'
      }
      style={{
        width: '100%',
        minWidth: 0,
        padding: '2px 4px',
        background: triggerBg,
        border: `1px solid ${triggerBorder}`,
        borderRadius: 4,
        color: triggerColor,
        cursor: 'pointer',
        fontSize: 9,
        letterSpacing: 0.3,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        boxSizing: 'border-box',
        boxShadow: open ? '0 0 0 1px rgba(190,190,190,0.10)' : 'none',
        transition: 'background 0.12s, border-color 0.12s, color 0.12s',
      }}
    >
      {hasSelectedTarget ? (
        <>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', fontSize: 11 }}>
            {selectedSummaryText}
          </span>
          {showPillClearAction && (
            <span
              role="button"
              aria-label="Clear missing Run after tab"
              title="Clear selected tab"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setRunAfterTab(tabId, null);
                setOpen(false);
              }}
              style={{ width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#77777d' }}
            >
              <X size={10} strokeWidth={2.4} aria-hidden="true" />
            </span>
          )}
        </>
      ) : (
        <>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M6 9l6 6 6-6" />
          </svg>
          <span>{emptyLabel}</span>
        </>
      )}
    </button>
  );

  const renderContextRowTrigger = () => (
    <button
      ref={internalTriggerRef}
      data-context-menu-row="ordinary"
      onClick={(e) => {
        e.stopPropagation();
        if (onTriggerClick?.()) return;
        if (openOnHover) {
          if (!open) handleOpen();
          return;
        }
        open ? setOpen(false) : handleOpen();
      }}
      onMouseEnter={() => {
        setTriggerHover(true);
        if (openOnHover && !open) handleOpen();
      }}
      onMouseLeave={() => setTriggerHover(false)}
      title={hasSelectedTarget ? `Selected trigger: ${selectedSummaryText}` : 'Pick a trigger tab'}
      style={{
        ...CONTEXT_MENU_ROW_STYLE,
        width: '100%',
        position: 'relative',
        background: triggerHover || open ? 'rgba(255,255,255,0.10)' : 'transparent',
        border: 'none',
        color: '#ccc',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        textAlign: 'left',
        fontSize: 13,
        overflow: 'hidden',
      }}
    >
      {/* Shared tab signal (TabSignals) — the trigger mirrors the state of the
          tab it points at. */}
      <TabProcessBar
        hasProcess={false}
        busy={selectedStatus === 'busy'}
        inheritedBusy={selectedStatus === 'inherited'}
        zIndex={1}
      />
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 0 }}>
        {triggerIcon && (
          <span style={{ ...CONTEXT_MENU_ICON_SLOT_STYLE, color: hasSelectedTarget ? accentColor : '#666' }}>
            {triggerIcon}
          </span>
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{triggerLabel}</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1, justifyContent: 'flex-end' }}>
        {showTargetSummary && (
          <>
            {showRuntimeDot && selectedTab && (
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: AI_KIND_COLOR[selectedTab.kind], flexShrink: 0 }} />
            )}
            <span
              style={{
                color: hasSelectedTarget ? accentTextColor : '#666',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 116,
              }}
            >
              {selectedSummaryText}
            </span>
          </>
        )}
        <span style={{ color: '#666', flexShrink: 0 }}>{'>'}</span>
      </span>
    </button>
  );

  return (
    <>
      <style>{`
        @keyframes run-after-picker-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      {!hideTrigger && (
        <ControlHint
          label={hasSelectedTarget && navigateOnPillClick ? 'Перейти к вкладке; карандаш или ПКМ — изменить условие' : hasSelectedTarget
            ? `Изменить вкладку ожидания: ${selectedSummaryText}`
            : 'Выбрать вкладку, после которой продолжить'}
          disabled={open}
          side={triggerVariant === 'context-row' ? 'right' : 'left'}
        >
          {triggerVariant === 'context-row' ? renderContextRowTrigger() : renderPillTrigger()}
        </ControlHint>
      )}

      {open && anchor && createPortal(
        (
          <>
            {modalOverlay && (
              <div
                data-run-after-picker-overlay
                data-run-after-dismiss-owner={hoverOwner}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  dismissRef.current = { reason: 'outside', point: { clientX: e.clientX, clientY: e.clientY } };
                  setOpen(false);
                }}
                style={{
                  position: 'fixed',
                  inset: 0,
                  zIndex: zIndex - 1,
                  background: 'transparent',
                }}
              />
            )}
            <div
              ref={menuRef}
              data-run-after-picker-menu
              data-tab-context-menu-host={panelRef?.current?.getAttribute('data-tab-context-menu-host') || undefined}
              data-run-after-hover-owner={hoverOwner}
              data-run-after-click-open={!openOnHover && hoverOwner ? 'true' : undefined}
              style={{
                position: 'fixed',
                top: anchor.top,
                ...(anchor.left !== undefined ? { left: anchor.left } : { right: anchor.right }),
                width: anchor.width,
                maxWidth: 'calc(100vw - 16px)',
                maxHeight: anchor.maxHeight,
                background: TABBAR_PANEL_BG,
                border: `1px solid ${BORDER}`,
                borderRadius: 6,
                boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
                backdropFilter: 'blur(8px)',
                zIndex,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
            <div style={{
              padding: '6px 8px 5px',
              borderBottom: `1px solid ${BORDER}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
              fontSize: 10,
              color: TEXT_MUTED,
              flexShrink: 0,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {title}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                {multiSelect && onToggleAllTabs && <button
                  type="button"
                  data-run-after-select-all
                  aria-pressed={allSelected}
                  aria-label={allSelected ? 'Снять весь выбор' : `Выбрать все вкладки: ${selectedWorkflow?.name || ''}`}
                  disabled={!selectedWorkflow}
                  title={allSelected ? 'Снять весь выбор, включая ранее выбранные вкладки'
                    : `Все вкладки «${selectedWorkflow?.name || ''}», включая новые`}
                  onClick={() => { if (selectedWorkflow) onToggleAllTabs(selectedWorkflow.workflowId); }}
                  onMouseEnter={() => setAllHover(true)}
                  onMouseLeave={() => setAllHover(false)}
                  style={{ flexShrink: 0, padding: '1px 5px', borderRadius: 999,
                    border: `1px solid ${allSelected ? 'rgba(255,255,255,0.38)' : BORDER}`,
                    background: allHover ? `${DEEP_PULSE}26` : (allSelected ? `${DEEP_PULSE}33` : 'transparent'),
                    color: allHover || allSelected ? '#fff' : TEXT_MUTED, cursor: 'pointer', fontSize: 9, lineHeight: 1.35 }}
                >All</button>}
                <button
                  data-run-after-visibility-filter
                  onClick={() => setShowAllTabs((v) => !v)}
                  onMouseEnter={() => setCountHover(true)}
                  onMouseLeave={() => setCountHover(false)}
                  title={showAllTabs ? 'Show only active or waiting tabs' : 'Show all AI tabs'}
                  style={{
                    flexShrink: 0,
                    padding: '1px 5px',
                    border: `1px solid ${showAllTabs ? 'rgba(255,255,255,0.38)' : BORDER}`,
                    borderRadius: 999,
                    background: countHover ? `${DEEP_PULSE}26` : (showAllTabs ? `${DEEP_PULSE}33` : 'transparent'),
                    color: countHover || showAllTabs ? '#fff' : TEXT_DIM,
                    cursor: 'pointer',
                    fontSize: 9,
                    lineHeight: 1.35,
                  }}
                >
                  {activeCount}/{targetTabs.length}
                </button>
                </div>
              </div>

              <div
                ref={workflowStripRef}
                data-run-after-workflow-strip={workflowIconsOnly ? 'icons' : 'labels'}
                className="scrollbar-hide"
                style={{
                  display: 'flex',
                  gap: 4,
                  flexWrap: workflowIconsOnly ? 'wrap' : 'nowrap',
                  overflowX: workflowIconsOnly ? 'hidden' : 'auto',
                  overflowY: 'hidden',
                  paddingBottom: 1,
                }}
              >
                {inventory.groups.map((g) => (
                  <WorkflowChip
                    key={g.workflowId}
                    workflowId={g.workflowId}
                    iconOnly={workflowIconsOnly}
                    label={g.name}
                    icon={g.icon}
                    unplaced={g.unplaced}
                    selected={g.workflowId === selectedWorkflow?.workflowId}
                    isOwner={g.isOwnerWorkflow}
                    count={g.tabs.filter((t) => t.id !== tabId && statusFor(t.id) !== 'idle').length}
                    total={g.tabs.filter((t) => t.id !== tabId).length}
                    onClick={() => setSelectedWorkflowId(g.workflowId)}
                  />
                ))}
              </div>
            </div>

            <div className="scrollbar-thin" style={{ overflowY: 'auto', flex: '1 1 auto', minHeight: 0, padding: 3 }}>
              {!selectedWorkflow && (
                <div style={{ padding: '12px 8px', fontSize: 9, color: TEXT_DIM, textAlign: 'center', lineHeight: 1.4 }}>
                  no workflows
                </div>
              )}
              {selectedWorkflow && targetTabs.length === 0 && (
                <div style={{ padding: '12px 8px', fontSize: 9, color: TEXT_DIM, textAlign: 'center', lineHeight: 1.4 }}>
                  no target AI tabs<br />
                  <span style={{ color: '#555' }}>start Claude / Codex / Gemini in another tab</span>
                </div>
              )}
              {selectedWorkflow && targetTabs.length > 0 && visibleRows.length === 0 && (
                <div style={{ padding: '12px 8px', fontSize: 9, color: TEXT_DIM, textAlign: 'center', lineHeight: 1.4 }}>
                  no active or waiting tabs<br />
                  <span style={{ color: '#555' }}>click {activeCount}/{targetTabs.length} to show all</span>
                </div>
              )}
              {selectedWorkflow && visibleRows.map((row) => {
                if (row.type === 'tab') {
                  const isSelected = selectedIdSet.has(row.tab.id);
                  return (
                    <PickerTabRow
                      key={row.tab.id}
                      tab={row.tab}
                      showTaskMarkers={showTaskMarkers}
                      selected={isSelected}
                      active={autoRun}
                      status={statusFor(row.tab.id)}
                      sessionStatuses={sessionStatuses}
                      tabGeo={tabGeo}
                      fontSize={tabsFontSize}
                      onClick={() => {
                        setRunAfterTab(tabId, multiSelect ? row.tab.id : (isSelected ? null : row.tab.id));
                        if (closeOnSelect) setOpen(false);
                      }}
                    />
                  );
                }
                return (
                  <PickerGroupRow
                    key={`${row.projectId}:${row.group.id}`}
                    projectId={row.projectId}
                    group={row.group}
                    tabs={row.tabs}
                    showTaskMarkers={showTaskMarkers}
                    active={autoRun}
                    selectedTabId={runAfterTabId}
                    selectedTabIds={selectedIdSet}
                    statusFor={statusFor}
                    sessionStatuses={sessionStatuses}
                    tabGeo={tabGeo}
                    fontSize={tabsFontSize}
                    onToggle={() => {
                      const state=useWorkspaceStore.getState();
                      if(!state.organizationReady){toggleTabGroupCollapsed(row.projectId,row.group.id);return;}
                      const publication=state.globalGroups,group=publication?.groups.find((g:any)=>g.id===row.group.id);
                      if(!group)return;
                      void state.mutateWorkflowGroup('collapse',{version:1,mutationId:crypto.randomUUID(),
                        expectedRevision:publication.revision,groupId:group.id,expectedGroupRevision:group.revision,
                        collapsed:!group.collapsed}).catch(error=>useUIStore.getState().showToast(String(error?.message || error),'error'));
                    }}
                    onSelect={(targetId, isSelected) => {
                      setRunAfterTab(tabId, multiSelect ? targetId : (isSelected ? null : targetId));
                      if (closeOnSelect) setOpen(false);
                    }}
                  />
                );
              })}
            </div>
            </div>
          </>
        ),
        portalContainer
      )}
    </>
  );
}

function WorkflowChip({
  workflowId,
  iconOnly,
  label,
  icon,
  unplaced,
  selected,
  isOwner,
  count,
  total,
  onClick,
}: {
  workflowId: string;
  iconOnly?: boolean;
  label: string;
  icon: string | null;
  unplaced: boolean;
  selected: boolean;
  isOwner: boolean;
  count: number;
  total: number;
  onClick: () => void;
}) {
  return (
    <WorkflowChipPresentation workflowId={workflowId} label={label} icon={icon} unplaced={unplaced}
      iconOnly={iconOnly}
      selected={selected}
      data-run-after-workflow-chip={workflowId}
      onClick={onClick}
      title={`${label}: ${count} loader / ${total} AI tabs`}
    >
      {!iconOnly && isOwner && <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#fff', opacity: 0.7, flexShrink: 0 }} />}
      {!iconOnly && count > 0 && <span style={{ color: selected ? '#fff' : PULSE, fontSize: 8, flexShrink: 0 }}>{count}</span>}
    </WorkflowChipPresentation>
  );
}

type SessionStatusLike = { id: string; label: string; color: string };
type MarkerShape = 'dot' | 'square';
type ProcessBarPosition = 'left' | 'right';
type PickerTabGeometry = { paddingY: number; paddingX: number; paddingLeft: number; borderRadius: number };

function PickerGroupRow({
  projectId,
  group,
  tabs,
  active,
  selectedTabId,
  selectedTabIds,
  statusFor,
  sessionStatuses,
  tabGeo,
  fontSize,
  onToggle,
  onSelect,
  showTaskMarkers,
}: {
  projectId: string;
  group: TabGroup;
  tabs: AiTab[];
  active: boolean;
  selectedTabId: string | null;
  selectedTabIds?: Set<string>;
  statusFor: (id: string) => TabRuntimeStatus;
  sessionStatuses: SessionStatusLike[];
  tabGeo: PickerTabGeometry;
  fontSize: number;
  onToggle: () => void;
  onSelect: (tabId: string, isSelected: boolean) => void;
  showTaskMarkers?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const collapsed = !!group.collapsed;
  const groupColor = group.color && group.color !== 'default' ? group.color : undefined;
  const groupColorConfig = TAB_COLORS.find((c) => c.color === groupColor);
  const folderColor = groupColorConfig?.borderColor || '#8b5cf6';
  const statusMeta = group.sessionStatus
    ? sessionStatuses.find((status) => status.id === group.sessionStatus)
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: collapsed ? 0 : 3 }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: '100%',
          position: 'relative',
          minHeight: 24,
          padding: `${Math.max(2, tabGeo.paddingY)}px ${tabGeo.paddingX}px ${Math.max(2, tabGeo.paddingY)}px ${tabGeo.paddingLeft}px`,
          borderRadius: tabGeo.borderRadius,
          border: `1px solid ${groupColorConfig?.borderColor || (collapsed ? 'rgba(139,92,246,0.42)' : 'rgba(255,255,255,0.08)')}`,
          background: pickerGroupBackground(group, hover),
          color: hover || collapsed ? '#e5e7eb' : '#a1a1aa',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize,
          lineHeight: 1.18,
          textAlign: 'left',
          boxSizing: 'border-box',
        }}
        title={collapsed ? 'Expand group' : 'Collapse group'}
      >
        <TabStatusMarker color={statusMeta?.color} title={statusMeta?.label} />
        <span
          style={{
            position: 'relative',
            width: 20,
            height: 20,
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 6,
            color: hover || collapsed ? '#c4b5fd' : folderColor,
            backgroundColor: hover || collapsed ? 'rgba(139,92,246,0.18)' : 'transparent',
          }}
        >
          <Folder size={14} strokeWidth={2} />
          <ChevronDown
            size={9}
            strokeWidth={2.4}
            style={{
              position: 'absolute',
              right: 2,
              bottom: 1,
              color: '#ddd6fe',
              opacity: hover || collapsed ? 1 : 0.62,
              transform: `rotate(${collapsed ? -90 : 0}deg)`,
              transformOrigin: 'center',
              transition: 'transform 140ms ease, opacity 120ms ease',
            }}
          />
        </span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {group.name}
        </span>
        <span style={{ color: '#71717a', fontSize: Math.max(10, fontSize - 2), flexShrink: 0 }}>{tabs.length}</span>
      </button>
      <div
        data-run-after-picker-group-body={group.id}
        data-project-id={projectId}
        style={{
          display: 'grid',
          gridTemplateRows: collapsed ? '0fr' : '1fr',
          transition: 'grid-template-rows 140ms ease',
          overflow: 'hidden',
        }}
      >
        <div style={{ minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 3, paddingTop: collapsed ? 0 : 3 }}>
          {tabs.map((tab) => {
            const isSelected = selectedTabIds?.has(tab.id) ?? selectedTabId === tab.id;
            return (
              <PickerTabRow
                key={tab.id}
                tab={tab}
                showTaskMarkers={showTaskMarkers}
                selected={isSelected}
                active={active}
                status={statusFor(tab.id)}
                sessionStatuses={sessionStatuses}
                tabGeo={tabGeo}
                fontSize={fontSize}
                onClick={() => onSelect(tab.id, isSelected)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PickerTabRow({
  buttonRef,
  tab,
  label,
  selected,
  active,
  status,
  sessionStatuses,
  tabGeo,
  fontSize,
  onClick,
  onAuxClick,
  onContextMenu,
  titleText,
  trailingActions,
  showTaskMarkers,
}: {
  buttonRef?: RefObject<HTMLButtonElement | null>;
  tab: AiTab;
  label?: string;
  selected: boolean;
  active: boolean;
  status: TabRuntimeStatus;
  sessionStatuses: SessionStatusLike[];
  tabGeo: PickerTabGeometry;
  fontSize: number;
  onClick: (event: React.MouseEvent<HTMLElement>) => void;
  onAuxClick?: (event: React.MouseEvent<HTMLElement>) => void;
  onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
  titleText?: string;
  trailingActions?: ReactNode;
  showTaskMarkers?: boolean;
}) {
  return <TabCard as="button" ref={buttonRef} projectId={tab.projectId} tabId={tab.id}
    data-run-after-tab-row={tab.id} data-run-after-tab-status={status}
    selected={selected} active={selected && active} fullWidth
    geometry={tabGeo} fontSize={fontSize} label={label ?? tab.name} showProjectIcon reserveSignalSpace
    showTaskMarkers={showTaskMarkers}
    activityOverride={{ hasProcess: false, busy: status === 'busy', inheritedBusy: status === 'inherited' }}
    onClick={onClick}
    onAuxClick={onAuxClick}
    onContextMenu={onContextMenu}
    title={titleText ?? (status === 'waiting' ? `${tab.name} - waiting for its Run after trigger` : tab.name)}
    trailingActions={<>{status === 'waiting' && <RunAfterStatusIcon status="waiting" color={PULSE} />}{trailingActions}</>}
  />;
}

export function RunAfterStatusIcon({ status, color, title }: { status: TabRuntimeStatus; color: string; title?: string }) {
  if (status === 'idle') return null;
  const isBusy = status === 'busy' || status === 'inherited';
  return (
    <span
      title={title ?? (status === 'inherited'
        ? 'Child agent is running'
        : (status === 'busy' ? 'Agent is running' : 'Waiting for its Run after trigger'))}
      style={{ width: 11, height: 11, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
    >
      {isBusy ? (
        <LoaderCircle
          className="noted-infinite-animation"
          size={9}
          strokeWidth={3}
          color={color}
          aria-hidden="true"
          style={{ animation: 'run-after-picker-spin 1.35s linear infinite' }}
        />
      ) : (
        <Hourglass size={10} strokeWidth={2.2} color={color} aria-hidden="true" />
      )}
    </span>
  );
}
