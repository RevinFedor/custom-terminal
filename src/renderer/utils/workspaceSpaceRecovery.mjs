import {
  allPaneTabIds,
  packSplitSizes,
  paneTabs,
  sanitizePanes,
} from './splitPanesModel.mjs';
import { captureSpaceLayout, emptySpaceLayout } from './workspaceSpacesModel.mjs';

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
};

const fnv1a = (text) => {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
};

export function spacesWithLiveLayout(spaces, activeSpaceId, liveState) {
  const liveLayout = captureSpaceLayout(liveState || {});
  return (Array.isArray(spaces) ? spaces : []).map((space) => (
    space?.id === activeSpaceId ? { ...space, layout: liveLayout } : space
  ));
}

export function workspaceSpacesFingerprint(spaces, activeSpaceId, liveState) {
  const materialized = spacesWithLiveLayout(spaces, activeSpaceId, liveState);
  return fnv1a(JSON.stringify(stableValue({ activeSpaceId, spaces: materialized })));
}

const normalizeProjectIds = (raw, projectExists, isSystemProject) => {
  const seen = new Set();
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach((value) => {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || seen.has(id) || isSystemProject(id) || !projectExists(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
};

function normalizeRecoveredLayout(raw, { tabExists, projectExists, isSystemProject }) {
  const source = { ...emptySpaceLayout(), ...(raw && typeof raw === 'object' ? raw : {}) };
  const missingTabs = [];
  (Array.isArray(source.splitPanes) ? source.splitPanes : []).forEach((pane) => {
    paneTabs(pane).forEach((entry) => {
      if (!tabExists(entry.projectId, entry.tabId)) {
        missingTabs.push({ projectId: entry.projectId, tabId: entry.tabId });
      }
    });
  });

  const panes = sanitizePanes(
    source.splitPanes,
    source.splitFocusedIndex,
    tabExists,
  );
  const centerStrips = {};
  Object.entries(source.centerStrips || {}).forEach(([key, rawStrip]) => {
    const seen = new Set();
    const strip = (Array.isArray(rawStrip) ? rawStrip : []).filter((entry) => {
      if (!entry?.tabId || seen.has(entry.tabId) || !tabExists(entry.projectId, entry.tabId)) {
        if (entry?.tabId && !tabExists(entry.projectId, entry.tabId)) {
          missingTabs.push({ projectId: entry.projectId, tabId: entry.tabId });
        }
        return false;
      }
      seen.add(entry.tabId);
      return true;
    });
    if (strip.length > 1) centerStrips[key] = strip;
  });

  const safeProject = (value) => (
    typeof value === 'string'
    && value
    && !isSystemProject(value)
    && projectExists(value)
      ? value
      : null
  );
  const activeSpaceTab = source.activeSpaceTab?.tabId
    && tabExists(source.activeSpaceTab.projectId, source.activeSpaceTab.tabId)
    ? {
      projectId: source.activeSpaceTab.projectId,
      tabId: source.activeSpaceTab.tabId,
    }
    : null;

  return {
    layout: {
      splitPanes: panes.panes,
      splitFocusedIndex: panes.focusedIndex,
      splitSizes: packSplitSizes(panes.panes, source.splitSizes),
      centerStrips,
      activeProjectId: safeProject(source.activeProjectId),
      focusedProjectId: safeProject(source.focusedProjectId),
      activeSpaceTab,
    },
    missingTabs,
  };
}

/**
 * Merge evidence-backed workflow layouts into the live list.
 *
 * Existing ids are immutable unless named in `overwriteExistingIds`. This is
 * what lets recovery replace the damaged `main` layout while preserving newer
 * GT/Mac workflows that were created after the loss.
 */
export function recoverWorkspaceSpaces({
  spaces,
  activeSpaceId,
  liveState,
  candidates,
  overwriteExistingIds = [],
  expectedFingerprint,
  projectExists = () => true,
  tabExists = () => true,
  isSystemProject = () => false,
  reassignProjects = false,
} = {}) {
  const before = spacesWithLiveLayout(spaces, activeSpaceId, liveState);
  const fingerprintBefore = workspaceSpacesFingerprint(spaces, activeSpaceId, liveState);
  if (expectedFingerprint && expectedFingerprint !== fingerprintBefore) {
    return {
      ok: false,
      reason: 'workspace_changed',
      expectedFingerprint,
      fingerprintBefore,
    };
  }

  const overwrite = new Set(Array.isArray(overwriteExistingIds) ? overwriteExistingIds : []);
  const next = before.slice();
  const addedIds = [];
  const replacedIds = [];
  const skippedIds = [];
  const missingTabs = [];
  const recoveredProjectOwners = new Map();
  let lastRecoveredIndex = -1;

  (Array.isArray(candidates) ? candidates : []).forEach((candidate) => {
    const id = typeof candidate?.id === 'string' ? candidate.id.trim() : '';
    if (!id) return;
    const at = next.findIndex((space) => space?.id === id);
    if (at >= 0 && !overwrite.has(id)) {
      skippedIds.push(id);
      lastRecoveredIndex = at;
      return;
    }
    const normalized = normalizeRecoveredLayout(candidate.layout, {
      tabExists,
      projectExists,
      isSystemProject,
    });
    missingTabs.push(...normalized.missingTabs.map((entry) => ({ ...entry, spaceId: id })));
    const projectIds = normalizeProjectIds(
      candidate.projectIds,
      projectExists,
      isSystemProject,
    );
    projectIds.forEach((projectId) => recoveredProjectOwners.set(projectId, id));
    const previous = at >= 0 ? next[at] : null;
    const restored = {
      id,
      name: typeof candidate.name === 'string' && candidate.name.trim()
        ? candidate.name.trim()
        : (previous?.name || 'Workflow'),
      icon: Object.prototype.hasOwnProperty.call(candidate, 'icon')
        ? (typeof candidate.icon === 'string' ? candidate.icon : null)
        : (previous?.icon ?? null),
      projectIds: projectIds.length > 0 ? projectIds : (previous?.projectIds || []),
      layout: normalized.layout,
    };
    if (at >= 0) {
      next[at] = restored;
      replacedIds.push(id);
      lastRecoveredIndex = at;
    } else {
      const insertAt = lastRecoveredIndex >= 0 ? lastRecoveredIndex + 1 : next.length;
      next.splice(insertAt, 0, restored);
      addedIds.push(id);
      lastRecoveredIndex = insertAt;
    }
  });

  const reassigned = reassignProjects && recoveredProjectOwners.size > 0
    ? next.map((space) => ({
      ...space,
      projectIds: (space.projectIds || []).filter((projectId) => (
        !recoveredProjectOwners.has(projectId)
        || recoveredProjectOwners.get(projectId) === space.id
      )),
    }))
    : next;

  const activeSpace = reassigned.find((space) => space.id === activeSpaceId) || reassigned[0] || null;
  const fingerprintAfter = fnv1a(JSON.stringify(stableValue({
    activeSpaceId: activeSpace?.id || activeSpaceId || null,
    spaces: reassigned,
  })));
  return {
    ok: true,
    spaces: reassigned,
    activeSpaceId: activeSpace?.id || activeSpaceId || null,
    activeLayout: activeSpace?.layout || emptySpaceLayout(),
    addedIds,
    replacedIds,
    skippedIds,
    missingTabs,
    fingerprintBefore,
    fingerprintAfter,
    visibleTabIds: activeSpace ? Array.from(allPaneTabIds(activeSpace.layout?.splitPanes || [])) : [],
  };
}
