import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject, WheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Folder, X } from 'lucide-react';
import { useWorkspaceStore, type TabColor, type TabGroup } from '../../store/useWorkspaceStore';
import { useUIStore } from '../../store/useUIStore';
import { getBusyTabsSnapshot } from '../../hooks/usePromptQueueRunner';

const { ipcRenderer } = window.require('electron');

// Shared picker used by:
// - PromptQueueOverlay: "Run after" selects the AI tab that should trigger queue continuation.
// - TabBar context menu: "Restart after" selects the AI tab whose loader completion restarts a terminal tab.
//
// Keep this component free of prompt-queue or tab-context-menu store writes. Callers own persistence
// through setRunAfterTab so the same project/tab inventory and busy-state UI can be reused safely.

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
};

type AiProjectGroup = {
  projectId: string;
  name: string;
  isOwnerProject: boolean;
  tabs: AiTab[];
  rows: PickerRow[];
};

type PickerRow =
  | { type: 'tab'; tab: AiTab; index: number }
  | { type: 'group'; group: TabGroup; tabs: AiTab[]; index: number };

type PickerAnchor = {
  top: number;
  left?: number;
  right?: number;
  maxHeight: number;
};

export type RunAfterTabPickerProps = {
  tabId: string;
  autoRun: boolean;
  runAfterTabId: string | null;
  setRunAfterTab: (tabId: string, target: string | null) => void;
  panelRef: RefObject<HTMLDivElement>;
  ownerProjectId?: string | null;
  title?: string;
  emptyLabel?: string;
  showAllTabsOnOpen?: boolean;
  triggerVariant?: 'pill' | 'context-row';
  triggerLabel?: string;
  triggerIcon?: ReactNode;
  menuWidth?: number;
  zIndex?: number;
  side?: 'left' | 'right';
  accentColor?: string;
  accentTextColor?: string;
  showRuntimeDot?: boolean;
  showTargetSummary?: boolean;
  openOnHover?: boolean;
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

const getTabChromeColorConfig = (tab: Pick<AiTab, 'color' | 'tabType'>) => {
  const base = TAB_COLORS.find((c) => c.color === tab.color) || TAB_COLORS[0];
  return tab.tabType === 'claude-sdk' && tab.color === 'claude'
    ? { ...base, bgColor: 'rgba(210, 140, 90, 0.30)', borderColor: '#D28C5A' }
    : tab.tabType === 'file'
      ? { ...base, bgColor: '#181725', borderColor: '#8b5cf6' }
      : base;
};

const pickerTabBackground = (tab: AiTab, selected: boolean, hover: boolean): string => {
  const colorConfig = getTabChromeColorConfig(tab);
  const hasColor = tab.color && tab.color !== 'default';
  if (selected) {
    return flattenRgbaOnTabbarPanel(hasColor ? adjustRgbaAlpha(colorConfig.bgColor, 0.20) : 'rgba(255,255,255,0.16)');
  }
  if (hover) {
    return flattenRgbaOnTabbarPanel(hasColor ? adjustRgbaAlpha(colorConfig.bgColor, 0.08) : 'rgba(255,255,255,0.12)');
  }
  if (hasColor) return flattenRgbaOnTabbarPanel(colorConfig.bgColor);
  return flattenRgbaOnTabbarPanel('rgba(255,255,255,0.035)');
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

function buildPickerRows(tabs: AiTab[], tabGroups: TabGroup[]): PickerRow[] {
  const rows: PickerRow[] = [];
  const groupById = new Map(tabGroups.map((group) => [group.id, group]));
  const renderedGroups = new Set<string>();
  const tabsByGroup = new Map<string, AiTab[]>();

  for (const tab of tabs) {
    const groupId = tab.groupId && groupById.has(tab.groupId) ? tab.groupId : undefined;
    if (!groupId) continue;
    const groupTabs = tabsByGroup.get(groupId) || [];
    groupTabs.push(tab);
    tabsByGroup.set(groupId, groupTabs);
  }

  for (const tab of tabs) {
    const groupId = tab.groupId && groupById.has(tab.groupId) ? tab.groupId : undefined;
    if (!groupId) {
      rows.push({ type: 'tab', tab, index: rows.length });
      continue;
    }
    if (renderedGroups.has(groupId)) continue;
    const group = groupById.get(groupId)!;
    renderedGroups.add(groupId);
    rows.push({ type: 'group', group, tabs: tabsByGroup.get(groupId) || [], index: rows.length });
  }

  return rows;
}

function aiKindForTab(tab: {
  tabType?: string;
  commandType?: string;
  claudeSessionId?: string;
  codexSessionId?: string;
  geminiSessionId?: string;
}): AiTabKind | null {
  if (tab.tabType === 'claude-sdk') return 'claude-sdk';
  if (tab.commandType === 'claude' && !!tab.claudeSessionId) return 'claude-pty';
  if (tab.commandType === 'codex' && !!tab.codexSessionId) return 'codex';
  if (tab.commandType === 'gemini' && !!tab.geminiSessionId) return 'gemini';
  return null;
}

function projectLabel(projectPath: string, projectId: string): string {
  const clean = (projectPath || '').replace(/[\\/]+$/, '');
  return clean.split(/[\\/]/).filter(Boolean).pop() || projectId.slice(-8);
}

function pointInRect(rect: DOMRect, x: number, y: number, tolerance = HOVER_CLOSE_TOLERANCE): boolean {
  return (
    x >= rect.left - tolerance &&
    x <= rect.right + tolerance &&
    y >= rect.top - tolerance &&
    y <= rect.bottom + tolerance
  );
}

function pointInHoverBridge(triggerRect: DOMRect, menuRect: DOMRect, x: number, y: number, side: 'left' | 'right'): boolean {
  const left = side === 'right'
    ? Math.min(triggerRect.right, menuRect.left)
    : Math.min(menuRect.right, triggerRect.left);
  const right = side === 'right'
    ? Math.max(triggerRect.right, menuRect.left)
    : Math.max(menuRect.right, triggerRect.left);
  const top = Math.min(triggerRect.top, menuRect.top) - HOVER_CLOSE_TOLERANCE;
  const bottom = Math.max(triggerRect.bottom, menuRect.bottom) + HOVER_CLOSE_TOLERANCE;
  return x >= left - HOVER_CLOSE_TOLERANCE && x <= right + HOVER_CLOSE_TOLERANCE && y >= top && y <= bottom;
}

export function RunAfterTabPicker({
  tabId,
  autoRun,
  runAfterTabId,
  setRunAfterTab,
  panelRef,
  ownerProjectId: ownerProjectIdProp = null,
  title = 'Run after - pick a tab',
  emptyLabel = 'on tab',
  showAllTabsOnOpen = false,
  triggerVariant = 'pill',
  triggerLabel = 'Run after',
  triggerIcon = null,
  menuWidth = 252,
  zIndex = FLOATING_OVERLAY_Z_INDEX,
  side = 'left',
  accentColor = '#10A37F',
  accentTextColor = '#a7f3d0',
  showRuntimeDot = true,
  showTargetSummary = true,
  openOnHover = false,
}: RunAfterTabPickerProps) {
  const toggleTabGroupCollapsed = useWorkspaceStore((state) => state.toggleTabGroupCollapsed);
  const sessionStatuses = useUIStore((state) => state.sessionStatuses);
  const statusMarkerShape = useUIStore((state) => state.statusMarker.shape);
  const statusMarkerSize = useUIStore((state) => state.statusMarker.sizePx);
  const processBarPosition = useUIStore((state) => state.processBar.position);
  const tabGeo = useUIStore((state) => state.tabGeometry);
  const tabsFontSize = useUIStore((state) => state.tabsFontSize);

  const fingerprint = useWorkspaceStore((state) => {
    let ownerProjectId: string | null = null;
    const parts: string[] = ['owner:'];
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
        ].join(':'));
      }
      parts.push(projectBits.join('~'));
    }
    parts[0] = 'owner:' + (ownerProjectId || '');
    return parts.join('|');
  });

  const inventory = useMemo<{ groups: AiProjectGroup[]; ownerProjectId: string | null; selectedTargetProjectId: string | null }>(() => {
    if (!fingerprint) return { groups: [], ownerProjectId: null, selectedTargetProjectId: null };
    const state = useWorkspaceStore.getState();
    let ownerProjectId: string | null = ownerProjectIdProp;
    let selectedTargetProjectId: string | null = null;
    const groups: AiProjectGroup[] = [];

    for (const [projectId, ws] of state.openProjects) {
      const isOwnerProject = ws.tabs.has(tabId) || projectId === ownerProjectIdProp;
      if (ws.tabs.has(tabId)) ownerProjectId = projectId;
      const tabs: AiTab[] = [];
      for (const t of ws.tabs.values()) {
        if (t.parentTabId) continue;
        const kind = aiKindForTab(t);
        if (!kind) continue;
        const row = {
          id: t.id,
          name: t.name || t.id.slice(-6),
          kind,
          projectId,
          color: t.color,
          tabType: t.tabType,
          groupId: t.groupId,
          visualParentTabId: t.visualParentTabId,
          sessionStatus: t.sessionStatus,
        };
        tabs.push(row);
        if (t.id === runAfterTabId) selectedTargetProjectId = projectId;
      }
      const orderedTabs = orderTabsWithVisualChildren(tabs);
      const rows = buildPickerRows(orderedTabs, ws.tabGroups || []);
      if (tabs.length > 0 || isOwnerProject) {
        groups.push({
          projectId,
          name: projectLabel(ws.projectPath, projectId),
          isOwnerProject,
          tabs: orderedTabs,
          rows,
        });
      }
    }

    return { groups, ownerProjectId, selectedTargetProjectId };
  }, [fingerprint, ownerProjectIdProp, tabId, runAfterTabId]);

  const [busyMap, setBusyMap] = useState<Map<string, boolean>>(() => getBusyTabsSnapshot());
  useEffect(() => {
    setBusyMap(getBusyTabsSnapshot());

    const isNonClaudePtyAiTab = (tid: string): boolean => {
      const state = useWorkspaceStore.getState();
      for (const ws of state.openProjects.values()) {
        const tab = ws.tabs.get(tid);
        if (!tab) continue;
        return tab.commandType === 'codex' || tab.commandType === 'gemini';
      }
      return false;
    };

    const apply = (tid: string, busy: boolean) =>
      setBusyMap((prev) => {
        if (prev.get(tid) === busy) return prev;
        const next = new Map(prev);
        next.set(tid, busy);
        return next;
      });

    const handleClaudeBusy = (_: unknown, { tabId: tid, busy, reason }: { tabId: string; busy: boolean; reason?: string }) => {
      if (reason === 'spinner' && isNonClaudePtyAiTab(tid)) return;
      apply(tid, busy);
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
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [showAllTabs, setShowAllTabs] = useState(showAllTabsOnOpen);
  const [countHover, setCountHover] = useState(false);
  const [triggerHover, setTriggerHover] = useState(false);
  const [portalContainer] = useState(() => {
    const el = document.createElement('div');
    el.dataset.runAfterPickerPortal = 'true';
    return el;
  });
  const [anchor, setAnchor] = useState<PickerAnchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.body.appendChild(portalContainer);
    return () => {
      if (portalContainer.parentNode) {
        portalContainer.parentNode.removeChild(portalContainer);
      }
    };
  }, [portalContainer]);

  useEffect(() => {
    const exists = selectedProjectId && inventory.groups.some((g) => g.projectId === selectedProjectId);
    if (exists) return;
    setSelectedProjectId(inventory.selectedTargetProjectId ?? inventory.ownerProjectId ?? inventory.groups[0]?.projectId ?? null);
  }, [inventory.groups, inventory.ownerProjectId, inventory.selectedTargetProjectId, selectedProjectId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
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
        const x = e.clientX;
        const y = e.clientY;
        if (pointInRect(triggerRect, x, y)) return;
        if (pointInRect(menuRect, x, y)) return;
        if (pointInHoverBridge(triggerRect, menuRect, x, y, side)) return;
        setOpen(false);
      });
    };
    window.addEventListener('mousemove', onMove, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('mousemove', onMove, true);
    };
  }, [open, openOnHover, side]);

  const handleOpen = useCallback(() => {
    const panelRect = panelRef.current?.getBoundingClientRect() ?? null;
    const triggerRect = triggerRef.current?.getBoundingClientRect() ?? null;
    const verticalRect = triggerVariant === 'context-row' && triggerRect ? triggerRect : panelRect;
    const horizontalRect = panelRect ?? triggerRect;
    if (!verticalRect || !horizontalRect) return;
    const top = Math.max(8, verticalRect.top);
    const nextAnchor: PickerAnchor = {
      top,
      maxHeight: Math.max(180, window.innerHeight - top - 8),
    };
    if (side === 'right') {
      nextAnchor.left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, horizontalRect.right + 6));
    } else {
      nextAnchor.right = window.innerWidth - horizontalRect.left + 6;
    }
    setAnchor({
      ...nextAnchor,
    });
    setSelectedProjectId(inventory.selectedTargetProjectId ?? inventory.ownerProjectId ?? inventory.groups[0]?.projectId ?? null);
    setShowAllTabs(showAllTabsOnOpen);
    setOpen(true);
  }, [inventory.groups, inventory.ownerProjectId, inventory.selectedTargetProjectId, menuWidth, panelRef, showAllTabsOnOpen, side, triggerVariant]);

  const handleProjectWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (delta === 0) return;
    const before = el.scrollLeft;
    el.scrollLeft += delta;
    if (el.scrollLeft !== before) e.preventDefault();
  }, []);

  type Status = 'busy' | 'idle';
  const statusFor = (id: string): Status => (busyMap.get(id) === true ? 'busy' : 'idle');

  const allAiTabs = useMemo(() => inventory.groups.flatMap((g) => g.tabs), [inventory.groups]);
  const selectedTab = runAfterTabId ? allAiTabs.find((t) => t.id === runAfterTabId) ?? null : null;
  const selectedStatus = selectedTab ? statusFor(selectedTab.id) : null;
  const selectedProject = inventory.groups.find((g) => g.projectId === selectedProjectId) ?? inventory.groups[0] ?? null;
  const targetTabs = selectedProject ? selectedProject.tabs.filter((t) => t.id !== tabId) : [];
  const loaderCount = targetTabs.filter((t) => statusFor(t.id) === 'busy').length;
  const isVisibleTab = useCallback((t: AiTab) => {
    if (t.id === tabId) return false;
    return showAllTabs || statusFor(t.id) === 'busy' || t.id === runAfterTabId;
  }, [runAfterTabId, showAllTabs, tabId, busyMap]);
  const visibleRows = useMemo(() => {
    if (!selectedProject) return [];
    const rows: PickerRow[] = [];
    for (const row of selectedProject.rows) {
      if (row.type === 'tab') {
        if (isVisibleTab(row.tab)) rows.push(row);
        continue;
      }
      const visibleGroupTabs = row.tabs.filter(isVisibleTab);
      if (visibleGroupTabs.length === 0) continue;
      rows.push({ ...row, tabs: visibleGroupTabs });
    }
    return rows;
  }, [isVisibleTab, selectedProject]);

  const hasSelectedTarget = !!selectedTab;
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

  const renderPillTrigger = () => (
    <button
      ref={triggerRef}
      onClick={() => open ? setOpen(false) : handleOpen()}
      onMouseEnter={() => setTriggerHover(true)}
      onMouseLeave={() => setTriggerHover(false)}
      title={
        hasSelectedTarget && selectedTab
          ? (
            autoRun
              ? `Run after tab "${selectedTab.name}" finishes`
              : `Run after target saved: "${selectedTab.name}" (off)`
          ) + (selectedStatus === 'busy' ? ' (busy now)' : '')
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
      {hasSelectedTarget && selectedTab ? (
        <>
          <span
            role="button"
            aria-label="Clear selected Run after tab"
            title="Clear selected tab"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setRunAfterTab(tabId, null);
              setOpen(false);
            }}
            style={{
              width: 13,
              height: 13,
              borderRadius: 4,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              color: triggerHover ? '#f3f4f6' : 'transparent',
              background: triggerHover ? 'rgba(255,255,255,0.12)' : 'transparent',
              cursor: triggerHover ? 'pointer' : 'default',
              pointerEvents: triggerHover ? 'auto' : 'none',
              transition: 'background 0.12s, color 0.12s',
            }}
          >
            {triggerHover ? (
              <X size={10} strokeWidth={2.4} aria-hidden="true" />
            ) : (
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: AI_KIND_COLOR[selectedTab.kind] }} />
            )}
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', fontSize: 11 }}>
            {selectedTab.name}
          </span>
          <StatusIcon status={selectedStatus!} color={activeTargetWait ? '#fff' : '#cfcfcf'} />
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
      ref={triggerRef}
      onClick={(e) => {
        e.stopPropagation();
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
      title={hasSelectedTarget && selectedTab ? `Selected trigger: ${selectedTab.name}` : 'Pick a trigger tab'}
      style={{
        width: '100%',
        position: 'relative',
        padding: '6px 12px',
        background: triggerHover || open ? 'rgba(255,255,255,0.10)' : 'transparent',
        border: 'none',
        color: '#ccc',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        textAlign: 'left',
        fontSize: 13,
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      {selectedStatus === 'busy' && (
        <span
          className="tab-process-bar-static"
          style={{
            position: 'absolute',
            ...(processBarPosition === 'right' ? { right: 0 } : { left: 0 }),
            top: 0,
            bottom: 0,
            width: 3,
            pointerEvents: 'none',
            zIndex: 1,
            overflow: 'hidden',
          }}
        >
          <span className="tab-process-bar-ai-shimmer-overlay" />
        </span>
      )}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 0 }}>
        {triggerIcon && (
          <span style={{ display: 'inline-flex', color: hasSelectedTarget ? accentColor : '#666', flexShrink: 0 }}>
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
              {selectedTab?.name || (runAfterTabId ? 'Missing tab' : emptyLabel)}
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
      {triggerVariant === 'context-row' ? renderContextRowTrigger() : renderPillTrigger()}

      {open && anchor && createPortal(
        (
          <div
            ref={menuRef}
            data-run-after-picker-menu
            style={{
              position: 'fixed',
              top: anchor.top,
              ...(anchor.left !== undefined ? { left: anchor.left } : { right: anchor.right }),
              width: menuWidth,
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
                <button
                  onClick={() => setShowAllTabs((v) => !v)}
                  onMouseEnter={() => setCountHover(true)}
                  onMouseLeave={() => setCountHover(false)}
                  title={showAllTabs ? 'Show only tabs with loader' : 'Show all AI tabs'}
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
                  {loaderCount}/{targetTabs.length}
                </button>
              </div>

              <div
                className="scrollbar-hide"
                onWheel={handleProjectWheel}
                style={{
                  display: 'flex',
                  gap: 4,
                  overflowX: 'auto',
                  overflowY: 'hidden',
                  paddingBottom: 1,
                }}
              >
                {inventory.groups.map((g) => (
                  <ProjectChip
                    key={g.projectId}
                    label={g.name}
                    selected={g.projectId === selectedProject?.projectId}
                    isOwner={g.isOwnerProject}
                    count={g.tabs.filter((t) => t.id !== tabId && statusFor(t.id) === 'busy').length}
                    total={g.tabs.filter((t) => t.id !== tabId).length}
                    onClick={() => setSelectedProjectId(g.projectId)}
                  />
                ))}
              </div>
            </div>

            <div className="scrollbar-thin" style={{ overflowY: 'auto', flex: '1 1 auto', minHeight: 0, padding: 3 }}>
              {!selectedProject && (
                <div style={{ padding: '12px 8px', fontSize: 9, color: TEXT_DIM, textAlign: 'center', lineHeight: 1.4 }}>
                  no open projects
                </div>
              )}
              {selectedProject && targetTabs.length === 0 && (
                <div style={{ padding: '12px 8px', fontSize: 9, color: TEXT_DIM, textAlign: 'center', lineHeight: 1.4 }}>
                  no target AI tabs<br />
                  <span style={{ color: '#555' }}>start Claude / Codex / Gemini in another tab</span>
                </div>
              )}
              {selectedProject && targetTabs.length > 0 && visibleRows.length === 0 && (
                <div style={{ padding: '12px 8px', fontSize: 9, color: TEXT_DIM, textAlign: 'center', lineHeight: 1.4 }}>
                  no loader tabs<br />
                  <span style={{ color: '#555' }}>click {loaderCount}/{targetTabs.length} to show all</span>
                </div>
              )}
              {selectedProject && visibleRows.map((row) => {
                if (row.type === 'tab') {
                  const isSelected = runAfterTabId === row.tab.id;
                  return (
                    <PickerTabRow
                      key={row.tab.id}
                      tab={row.tab}
                      selected={isSelected}
                      active={autoRun}
                      busy={statusFor(row.tab.id) === 'busy'}
                      sessionStatuses={sessionStatuses}
                      statusMarkerShape={statusMarkerShape}
                      statusMarkerSize={statusMarkerSize}
                      processBarPosition={processBarPosition}
                      tabGeo={tabGeo}
                      fontSize={tabsFontSize}
                      onClick={() => {
                        setRunAfterTab(tabId, isSelected ? null : row.tab.id);
                        setOpen(false);
                      }}
                    />
                  );
                }
                return (
                  <PickerGroupRow
                    key={row.group.id}
                    projectId={selectedProject.projectId}
                    group={row.group}
                    tabs={row.tabs}
                    active={autoRun}
                    selectedTabId={runAfterTabId}
                    statusFor={statusFor}
                    sessionStatuses={sessionStatuses}
                    statusMarkerShape={statusMarkerShape}
                    statusMarkerSize={statusMarkerSize}
                    processBarPosition={processBarPosition}
                    tabGeo={tabGeo}
                    fontSize={tabsFontSize}
                    onToggle={() => toggleTabGroupCollapsed(selectedProject.projectId, row.group.id)}
                    onSelect={(targetId, isSelected) => {
                      setRunAfterTab(tabId, isSelected ? null : targetId);
                      setOpen(false);
                    }}
                  />
                );
              })}
            </div>
          </div>
        ),
        portalContainer
      )}
    </>
  );
}

function ProjectChip({
  label,
  selected,
  isOwner,
  count,
  total,
  onClick,
}: {
  label: string;
  selected: boolean;
  isOwner: boolean;
  count: number;
  total: number;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${label}: ${count} loader / ${total} AI tabs`}
      style={{
        flex: '0 0 auto',
        maxWidth: 118,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 6px',
        borderRadius: 999,
        border: `1px solid ${selected ? 'rgba(255,255,255,0.5)' : (hover ? `${DEEP_PULSE}55` : BORDER)}`,
        background: selected ? 'rgba(255,255,255,0.08)' : (hover ? `${DEEP_PULSE}1f` : 'transparent'),
        color: selected ? '#fff' : (hover ? '#ddd' : TEXT_DIM),
        cursor: 'pointer',
        fontSize: 9,
        lineHeight: 1.25,
        whiteSpace: 'nowrap',
        minWidth: 0,
      }}
    >
      {isOwner && <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#fff', opacity: 0.7, flexShrink: 0 }} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {count > 0 && <span style={{ color: selected ? '#fff' : PULSE, fontSize: 8, flexShrink: 0 }}>{count}</span>}
    </button>
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
  statusFor,
  sessionStatuses,
  statusMarkerShape,
  statusMarkerSize,
  processBarPosition,
  tabGeo,
  fontSize,
  onToggle,
  onSelect,
}: {
  projectId: string;
  group: TabGroup;
  tabs: AiTab[];
  active: boolean;
  selectedTabId: string | null;
  statusFor: (id: string) => 'busy' | 'idle';
  sessionStatuses: SessionStatusLike[];
  statusMarkerShape: MarkerShape;
  statusMarkerSize: number;
  processBarPosition: ProcessBarPosition;
  tabGeo: PickerTabGeometry;
  fontSize: number;
  onToggle: () => void;
  onSelect: (tabId: string, isSelected: boolean) => void;
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
        {statusMeta && (
          <span
            title={statusMeta.label}
            style={{
              position: 'absolute',
              left: 5,
              top: 'calc(50% + 1px)',
              transform: 'translateY(-50%)',
              width: statusMarkerSize,
              height: statusMarkerSize,
              borderRadius: statusMarkerShape === 'square' ? 2 : '50%',
              backgroundColor: statusMeta.color,
              border: '1px solid rgba(0,0,0,0.4)',
              pointerEvents: 'none',
            }}
          />
        )}
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
            const isSelected = selectedTabId === tab.id;
            return (
              <PickerTabRow
                key={tab.id}
                tab={tab}
                selected={isSelected}
                active={active}
                busy={statusFor(tab.id) === 'busy'}
                sessionStatuses={sessionStatuses}
                statusMarkerShape={statusMarkerShape}
                statusMarkerSize={statusMarkerSize}
                processBarPosition={processBarPosition}
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
  tab,
  selected,
  active,
  busy,
  sessionStatuses,
  statusMarkerShape,
  statusMarkerSize,
  processBarPosition,
  tabGeo,
  fontSize,
  onClick,
}: {
  tab: AiTab;
  selected: boolean;
  active: boolean;
  busy: boolean;
  sessionStatuses: SessionStatusLike[];
  statusMarkerShape: MarkerShape;
  statusMarkerSize: number;
  processBarPosition: ProcessBarPosition;
  tabGeo: PickerTabGeometry;
  fontSize: number;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const statusMeta = tab.sessionStatus
    ? sessionStatuses.find((status) => status.id === tab.sessionStatus)
    : null;
  const selectedActive = selected && active;

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: '100%',
        position: 'relative',
        minHeight: 24,
        padding: `${Math.max(2, tabGeo.paddingY)}px ${tabGeo.paddingX}px ${Math.max(2, tabGeo.paddingY)}px ${tabGeo.paddingLeft}px`,
        background: pickerTabBackground(tab, selected, hover),
        border: `1px solid ${selectedActive ? 'rgba(196,181,253,0.42)' : (selected ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.05)')}`,
        borderRadius: tabGeo.borderRadius,
        color: selectedActive ? '#fff' : (selected ? '#d8d8d8' : '#ddd'),
        cursor: 'pointer',
        fontSize,
        lineHeight: 1.18,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        textAlign: 'left',
        overflow: 'hidden',
        boxSizing: 'border-box',
        boxShadow: selectedActive ? 'inset 0 0 0 1px rgba(139,92,246,0.16)' : undefined,
      }}
      title={tab.name}
    >
      {busy && (
        <span
          className="tab-process-bar-static"
          style={{
            position: 'absolute',
            ...(processBarPosition === 'right' ? { right: 0 } : { left: 0 }),
            top: 0,
            bottom: 0,
            width: 3,
            pointerEvents: 'none',
            zIndex: 2,
            overflow: 'hidden',
            ...(processBarPosition === 'right'
              ? { borderTopRightRadius: tabGeo.borderRadius, borderBottomRightRadius: tabGeo.borderRadius }
              : { borderTopLeftRadius: tabGeo.borderRadius, borderBottomLeftRadius: tabGeo.borderRadius }),
          }}
        >
          <span className="tab-process-bar-ai-shimmer-overlay" />
        </span>
      )}
      {statusMeta && (
        <span
          title={statusMeta.label}
          style={{
            position: 'absolute',
            left: 5,
            top: 'calc(50% + 1px)',
            transform: 'translateY(-50%)',
            width: statusMarkerSize,
            height: statusMarkerSize,
            borderRadius: statusMarkerShape === 'square' ? 2 : '50%',
            backgroundColor: statusMeta.color,
            border: '1px solid rgba(0,0,0,0.4)',
            pointerEvents: 'none',
            zIndex: 3,
          }}
        />
      )}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {tab.name}
      </span>
    </button>
  );
}

function StatusIcon({ status, color }: { status: 'busy' | 'idle'; color: string }) {
  if (status !== 'busy') return null;
  return (
    <span style={{ flexShrink: 0, display: 'inline-flex' }}>
      <svg
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        aria-hidden="true"
        style={{ animation: 'run-after-picker-spin 1.35s linear infinite' }}
      >
        <path d="M12 2v4" />
        <path d="M12 18v4" />
        <path d="M4.93 4.93l2.83 2.83" />
        <path d="M16.24 16.24l2.83 2.83" />
        <path d="M2 12h4" />
        <path d="M18 12h4" />
        <path d="M4.93 19.07l2.83-2.83" />
        <path d="M16.24 7.76l2.83-2.83" />
      </svg>
    </span>
  );
}
