import { describeWorkspace } from './splitPanesModel.mjs';

const WINDOW_REF_PREFIX = 'ww1';

const normalizedLayout = (space) => ({
  splitPanes: Array.isArray(space?.layout?.splitPanes) ? space.layout.splitPanes : [],
  splitFocusedIndex: Number.isInteger(space?.layout?.splitFocusedIndex)
    ? space.layout.splitFocusedIndex
    : 0,
  activeSpaceTab: space?.layout?.activeSpaceTab?.tabId
    ? {
      projectId: String(space.layout.activeSpaceTab.projectId || ''),
      tabId: String(space.layout.activeSpaceTab.tabId),
    }
    : null,
  activeProjectId: typeof space?.layout?.activeProjectId === 'string'
    ? space.layout.activeProjectId
    : null,
  centerStrips: space?.layout?.centerStrips && typeof space.layout.centerStrips === 'object'
    ? space.layout.centerStrips
    : {},
});

export function encodeWorkspaceWindowRef({ spaceId, paneIndex, fingerprint }) {
  if (!spaceId || !fingerprint) return null;
  const pane = paneIndex === null || paneIndex === undefined ? 'center' : String(paneIndex);
  return [WINDOW_REF_PREFIX, encodeURIComponent(spaceId), pane, fingerprint].join(':');
}

export function decodeWorkspaceWindowRef(value) {
  const parts = typeof value === 'string' ? value.split(':') : [];
  if (parts.length !== 4 || parts[0] !== WINDOW_REF_PREFIX) return null;
  const paneIndex = parts[2] === 'center' ? null : Number(parts[2]);
  if (paneIndex !== null && (!Number.isInteger(paneIndex) || paneIndex < 0)) return null;
  try {
    return {
      spaceId: decodeURIComponent(parts[1]),
      paneIndex,
      fingerprint: parts[3],
    };
  } catch {
    return null;
  }
}

export function describeWorkspaceWindowTargets({
  spaces,
  activeSpaceId,
  fingerprint,
  tabInfo = () => null,
} = {}) {
  return (Array.isArray(spaces) ? spaces : []).map((space) => {
    const layout = normalizedLayout(space);
    const view = describeWorkspace(
      layout.splitPanes,
      layout.splitFocusedIndex,
      layout.activeSpaceTab,
    );
    if (!view.split && view.windows?.[0] && layout.activeSpaceTab?.tabId) {
      const key = layout.activeSpaceTab.projectId || layout.activeProjectId;
      const strip = Array.isArray(layout.centerStrips?.[key])
        ? layout.centerStrips[key]
        : [];
      if (strip.length > 0) {
        view.windows[0] = {
          ...view.windows[0],
          tabs: strip,
          shownTabId: layout.activeSpaceTab.tabId,
        };
      }
    }
    const windows = (view.windows || []).map((window) => {
      const tabs = (window.tabs || []).map((entry) => ({
        projectId: entry.projectId,
        tabId: entry.tabId,
        ...(tabInfo(entry.projectId, entry.tabId) || {}),
      }));
      const paneIndex = view.split ? window.index : null;
      return {
        index: window.index,
        paneIndex,
        windowRef: encodeWorkspaceWindowRef({
          spaceId: space.id,
          paneIndex,
          fingerprint,
        }),
        column: window.column,
        row: window.row,
        focused: window.focused === true,
        empty: window.empty === true || tabs.length === 0,
        shownTabId: window.shownTabId || null,
        tabs,
      };
    });
    return {
      id: space.id,
      name: space.name || 'Workflow',
      active: space.id === activeSpaceId,
      projectIds: Array.isArray(space.projectIds) ? space.projectIds.slice() : [],
      focusedWindowRef: windows.find((window) => window.focused)?.windowRef
        || windows[0]?.windowRef
        || null,
      windows,
      layout: space.layout || {},
    };
  });
}

export function workspacePlacementsForTab(describedSpaces, tabId) {
  if (!tabId) return [];
  const placements = [];
  for (const space of Array.isArray(describedSpaces) ? describedSpaces : []) {
    for (const window of space.windows || []) {
      const tabIndex = (window.tabs || []).findIndex((entry) => entry.tabId === tabId);
      if (tabIndex < 0) continue;
      placements.push({
        spaceId: space.id,
        spaceName: space.name,
        activeSpace: space.active === true,
        windowRef: window.windowRef,
        paneIndex: window.paneIndex,
        windowIndex: window.index,
        column: window.column,
        row: window.row,
        tabIndex,
        shown: window.shownTabId === tabId,
      });
    }
  }
  return placements;
}

const targetFailure = (reason, details = {}) => ({ ok: false, reason, ...details });

export function resolveWorkspaceWindowTarget({
  describedSpaces,
  activeSpaceId,
  sourceTabId,
  fingerprint,
  target = {},
} = {}) {
  const spaces = Array.isArray(describedSpaces) ? describedSpaces : [];
  if (spaces.length === 0) return targetFailure('workspace_unavailable');

  const sourcePlacements = workspacePlacementsForTab(spaces, sourceTabId);
  const preferredSource = sourcePlacements.find((placement) => placement.activeSpace)
    || sourcePlacements[0]
    || null;
  const explicitSpaceId = typeof target.spaceId === 'string' && target.spaceId
    ? target.spaceId
    : null;
  const spaceId = explicitSpaceId
    || (target.space === 'active' ? activeSpaceId : null)
    || preferredSource?.spaceId
    || activeSpaceId
    || spaces[0].id;
  const space = spaces.find((candidate) => candidate.id === spaceId);
  if (!space) return targetFailure('space_not_found', { spaceId });

  let window = null;
  if (target.windowRef) {
    const decoded = decodeWorkspaceWindowRef(target.windowRef);
    if (!decoded) return targetFailure('window_ref_invalid');
    if (decoded.fingerprint !== fingerprint) {
      return targetFailure('stale_layout', {
        expectedFingerprint: decoded.fingerprint,
        fingerprint,
      });
    }
    if (decoded.spaceId !== space.id) {
      return targetFailure('window_space_mismatch', {
        windowSpaceId: decoded.spaceId,
        spaceId: space.id,
      });
    }
    window = (space.windows || []).find((candidate) => candidate.paneIndex === decoded.paneIndex) || null;
  } else if (Number.isInteger(target.windowIndex)) {
    window = (space.windows || []).find((candidate) => candidate.index === target.windowIndex) || null;
  } else {
    const anchorTabId = target.anchorTabId
      || (target.anchor === 'source' || (!target.anchor && !explicitSpaceId) ? sourceTabId : null);
    if (anchorTabId) {
      window = (space.windows || []).find((candidate) => (
        (candidate.tabs || []).some((entry) => entry.tabId === anchorTabId)
      )) || null;
    }
    if (!window && target.anchor !== 'source') {
      window = (space.windows || []).find((candidate) => candidate.focused)
        || space.windows?.[0]
        || null;
    }
  }
  if (!window) return targetFailure('window_not_found', { spaceId: space.id });

  const mode = target.mode === 'new-window' ? 'new-window' : 'same-window';
  const side = ['left', 'right', 'above', 'below'].includes(target.side)
    ? target.side
    : 'right';
  const sourceIndex = sourceTabId
    ? (window.tabs || []).findIndex((entry) => entry.tabId === sourceTabId)
    : -1;
  const requestedIndex = Number.isInteger(target.insertIndex) ? target.insertIndex : null;
  const insertIndex = requestedIndex === null
    ? (sourceIndex >= 0 ? sourceIndex + 1 : (window.tabs || []).length)
    : Math.max(0, Math.min(requestedIndex, (window.tabs || []).length));

  return {
    ok: true,
    space,
    spaceId: space.id,
    window,
    windowRef: window.windowRef,
    paneIndex: window.paneIndex,
    windowIndex: window.index,
    insertIndex,
    mode,
    side,
    reveal: target.reveal === true,
    sourcePlacements,
    preferredSource,
  };
}

const pathWithin = (cwd, root) => cwd === root || cwd.startsWith(root.endsWith('/') ? root : root + '/');

export function resolveWorkspaceCreationContext({
  explicitProjectId,
  explicitCwd,
  targetSpace,
  targetWindow,
  sourceTabId,
  tabInfo = () => null,
  projects = [],
} = {}) {
  const projectRows = (Array.isArray(projects) ? projects : []).filter((project) => project?.id);
  const byId = (projectId) => projectRows.find((project) => project.id === projectId) || null;

  if (explicitProjectId) {
    const project = byId(explicitProjectId);
    if (!project) return targetFailure('project_not_found', { projectId: explicitProjectId });
    const source = !explicitCwd && sourceTabId
      ? tabInfo(project.id, sourceTabId)
      : null;
    return {
      ok: true,
      projectId: project.id,
      cwd: explicitCwd || source?.cwd || project.path,
      reason: explicitCwd
        ? 'explicit-project-cwd'
        : source?.cwd
          ? 'explicit-project-source-tab'
          : 'explicit-project',
    };
  }

  if (explicitCwd) {
    const matches = projectRows
      .filter((project) => project.path && pathWithin(explicitCwd, project.path))
      .sort((a, b) => b.path.length - a.path.length);
    if (matches.length === 0) return targetFailure('project_not_found_for_cwd', { cwd: explicitCwd });
    if (matches.length > 1 && matches[0].path.length === matches[1].path.length) {
      return targetFailure('project_ambiguous_for_cwd', {
        cwd: explicitCwd,
        projectIds: matches.filter((project) => project.path.length === matches[0].path.length)
          .map((project) => project.id),
      });
    }
    return { ok: true, projectId: matches[0].id, cwd: explicitCwd, reason: 'explicit-cwd' };
  }

  const shown = targetWindow?.shownTabId
    ? (targetWindow.tabs || []).find((entry) => entry.tabId === targetWindow.shownTabId)
    : null;
  const sourceInWindow = sourceTabId
    ? (targetWindow?.tabs || []).find((entry) => entry.tabId === sourceTabId)
    : null;
  const contextual = sourceInWindow || shown;
  if (contextual) {
    const info = tabInfo(contextual.projectId, contextual.tabId) || contextual;
    const project = byId(contextual.projectId);
    return {
      ok: true,
      projectId: contextual.projectId,
      cwd: info.cwd || project?.path || null,
      reason: sourceInWindow ? 'source-window-tab' : 'shown-window-tab',
    };
  }

  const defaultProjectId = targetSpace?.projectIds?.[0] || null;
  if (defaultProjectId) {
    const project = byId(defaultProjectId);
    if (project) return { ok: true, projectId: project.id, cwd: project.path, reason: 'space-default-project' };
  }

  if (sourceTabId) {
    for (const project of projectRows) {
      const info = tabInfo(project.id, sourceTabId);
      if (!info) continue;
      return {
        ok: true,
        projectId: project.id,
        cwd: info.cwd || project.path,
        reason: 'source-tab',
      };
    }
  }
  return targetFailure('creation_context_unavailable');
}
