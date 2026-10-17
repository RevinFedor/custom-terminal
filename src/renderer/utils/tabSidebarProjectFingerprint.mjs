const pushScalar = (parts, value) => {
  const text = value === null || value === undefined ? '' : String(value);
  parts.push(text);
};

// Keep normalization at the original read sites; defer only pure encoding.
const encodeScalars = (scalars) => {
  const parts = new Array(scalars.length);
  for (let i = 0; i < scalars.length; i++) {
    const text = scalars[i];
    parts[i] = String(text.length) + ':' + text + '|';
  }
  return parts.join('');
};

// An object only locates a candidate. Every invocation still reads ALL current
// scalar fields in order, and reuse requires the entire normalized vector.
// One entry per live workspace; no Tab/Map identity or lossy hash is authority.
const workspaceEncodings = new WeakMap();
const encodeWorkspaceScalars = (workspace, scalars) => {
  const cacheable = typeof workspace === 'object' || typeof workspace === 'function';
  const previous = cacheable ? workspaceEncodings.get(workspace) : undefined;
  if (previous && previous.scalars.length === scalars.length
    && scalars.every((text, index) => text === previous.scalars[index])) {
    return previous.encoded;
  }
  const encoded = encodeScalars(scalars);
  // Invocation-local vectors: a getter/coercion can reenter this projection.
  // Store only a complete encoding. A throw cannot install a partial entry.
  if (cacheable) workspaceEncodings.set(workspace, { scalars, encoded });
  return encoded;
};

const pushList = (parts, values) => {
  const list = Array.isArray(values) ? values : [];
  pushScalar(parts, list.length);
  for (const value of list) pushScalar(parts, value);
};

const pushTaskPlan = (parts, plan) => {
  if (!plan || typeof plan !== 'object') {
    pushScalar(parts, '');
    return;
  }
  pushScalar(parts, plan.id);
  pushScalar(parts, plan.title);
  const items = Array.isArray(plan.items) ? plan.items : [];
  pushScalar(parts, items.length);
  for (const item of items) {
    pushScalar(parts, item?.id);
    pushScalar(parts, item?.status);
    pushScalar(parts, item?.title);
    const subtasks = Array.isArray(item?.subtasks) ? item.subtasks : [];
    pushScalar(parts, subtasks.length);
    for (const subtask of subtasks) {
      pushScalar(parts, subtask?.id);
      pushScalar(parts, subtask?.status);
      pushScalar(parts, subtask?.title);
    }
  }
  const archived = Array.isArray(plan.archivedItems) ? plan.archivedItems : [];
  pushScalar(parts, archived.length);
  for (const item of archived) {
    pushScalar(parts, item?.id);
    pushScalar(parts, item?.status);
  }
};

/**
 * Exact primitive projection of the fields that draw a project's sidebar.
 *
 * ProjectWorkspace/Tab objects are intentionally mutated in place and the
 * outer openProjects Map is cloned as the notification envelope. Subscribing
 * to that envelope repaints EVERY project; subscribing to the workspace object
 * misses in-place edits. This primitive is the boundary between those two bad
 * choices: Zustand still checks it on every store write, but React wakes only
 * when the rows of THIS project can actually look or order differently.
 */
export function tabSidebarProjectFingerprint(workspace) {
  if (!workspace) return 'missing';
  const parts = [];
  pushScalar(parts, workspace.projectId);
  pushScalar(parts, workspace.activeTabId);
  pushScalar(parts, workspace.activeGroupId);
  pushScalar(parts, workspace.currentView);
  pushScalar(parts, workspace.viewingSubAgentTabId);
  pushList(parts, workspace.selectedTabIds);

  const groups = Array.isArray(workspace.tabGroups) ? workspace.tabGroups : [];
  pushScalar(parts, groups.length);
  for (const group of groups) {
    pushScalar(parts, group?.id);
    pushScalar(parts, group?.name);
    pushScalar(parts, group?.color);
    pushScalar(parts, group?.collapsed);
    pushScalar(parts, group?.anchorTabId);
    pushScalar(parts, group?.sessionStatus);
  }

  const tabs = workspace.tabs instanceof Map ? Array.from(workspace.tabs.values()) : [];
  pushScalar(parts, tabs.length);
  for (const tab of tabs) {
    pushScalar(parts, tab?.id);
    pushScalar(parts, tab?.name);
    pushScalar(parts, tab?.cwd);
    pushScalar(parts, tab?.color);
    pushScalar(parts, tab?.commandType);
    pushScalar(parts, tab?.tabType);
    pushScalar(parts, tab?.filePath);
    pushScalar(parts, tab?.groupId);
    pushScalar(parts, tab?.visualParentTabId);
    pushScalar(parts, tab?.parentTabId);
    pushScalar(parts, tab?.isCollapsed);
    pushScalar(parts, tab?.sessionStatus);
    pushScalar(parts, tab?.claudeSessionId);
    pushScalar(parts, tab?.geminiSessionId);
    pushScalar(parts, tab?.codexSessionId);
    pushScalar(parts, tab?.wasInterrupted);
    pushScalar(parts, tab?.restoreError?.type);
    pushScalar(parts, tab?.restoreError?.message);
    pushScalar(parts, tab?.completionNotificationPersistent);
    pushScalar(parts, tab?.completionNotificationArmed);
    pushScalar(parts, tab?.completionNotificationFired);
    pushScalar(parts, tab?.restartAfterTabId);
    pushList(parts, tab?.restartAfterTabIds);
    pushList(parts, tab?.restartAfterWorkflowIds);
    pushScalar(parts, tab?.restartAfterCommand);
    pushScalar(parts, tab?.restartAfterPaused);
    pushScalar(parts, tab?.sdkProcessAlive);
    pushScalar(parts, tab?.sdkState);
    pushScalar(parts, tab?.aiClosing);
    pushScalar(parts, tab?.pendingOperation);
    pushScalar(parts, tab?.externalRun?.status);
    pushScalar(parts, tab?.externalRun?.collapsed);
    const tasks = Array.isArray(tab?.bgTasks) ? tab.bgTasks : [];
    pushScalar(parts, tasks.length);
    for (const task of tasks) {
      pushScalar(parts, task?.id);
      pushScalar(parts, task?.status);
      pushScalar(parts, task?.isError);
    }
    pushTaskPlan(parts, tab?.taskPlan);
  }
  return encodeWorkspaceScalars(workspace, parts);
}

const publicationFingerprints = new WeakMap();
// React can read the same selector repeatedly, and multiple retained surfaces
// can subscribe to one project. Share only within this published STATE object;
// a new publication must observe in-place edits to workspace/tab metadata.
// The direct function above remains a fresh reader for callers without STATE.
export function publishedTabSidebarProjectFingerprint(state, projectId) {
  let fingerprints = publicationFingerprints.get(state);
  if (!fingerprints) {
    fingerprints = new Map();
    publicationFingerprints.set(state, fingerprints);
  }
  if (!fingerprints.has(projectId)) {
    fingerprints.set(projectId, tabSidebarProjectFingerprint(state.openProjects.get(projectId)));
  }
  return fingerprints.get(projectId);
}

export function openProjectIdsFingerprint(openProjects) {
  if (!(openProjects instanceof Map)) return '';
  const parts = [];
  for (const projectId of openProjects.keys()) pushScalar(parts, projectId);
  return encodeScalars(parts);
}
