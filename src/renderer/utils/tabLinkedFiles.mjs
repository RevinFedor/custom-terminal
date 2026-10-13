// Catalog adapter kept separate from presentation: workflow membership may
// change, but an attachment is a direct visual link to a stable tab ID.
export function collectTabLinkedFiles(openProjects, ownerTabId) {
  const files = [], seen = new Set();
  if (!ownerTabId) return files;
  for (const [projectId, project] of openProjects || []) {
    for (const file of project.tabs?.values() || []) {
      if (file.tabType !== 'file' || !file.filePath || file.visualParentTabId !== ownerTabId) continue;
      const identity = `${projectId}\0${file.id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      files.push({ projectId, id: file.id, ownerTabId, path: file.filePath,
        name: file.filePath.split(/[\\/]/).pop() || file.name || file.filePath });
    }
  }
  return files;
}

// The menu follows only file edges. An independent AI child is a different
// owner, even if that child also has files. reserveOrder is the saved common
// ordering authority; Map insertion order is only the pre-order fallback.
export function collectTabLinkedFileTree(openProjects, ownerTabId, orderedIds = []) {
  return collectLinkedFileIndex(buildLinkedFileIndex(openProjects), ownerTabId,
    new Map(orderedIds.map((id, index) => [id, index])));
}

function buildLinkedFileIndex(openProjects) {
  const byParent = new Map();
  for(const [projectId,workspace] of openProjects || []) for(const file of workspace.tabs?.values() || []) {
    if(file.tabType!=='file' || !file.filePath || !file.visualParentTabId
      || file.archived || file.isArchived || file.archivedAt || file.deleted)continue;
    const children=byParent.get(file.visualParentTabId) || [];
    children.push({projectId,id:file.id,ownerTabId:undefined,path:file.filePath,
      name:file.filePath.split(/[\\/]/).pop() || file.name || file.filePath});
    byParent.set(file.visualParentTabId,children);
  }
  return byParent;
}

function collectLinkedFileIndex(byParent, ownerTabId, rank) {
  const result = [], visited = new Set([ownerTabId]);
  const visit = (parentId, depth) => {
    const children = (byParent.get(parentId) || []).slice()
      .sort((a,b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    for (const file of children) {
      if (visited.has(file.id)) continue;
      visited.add(file.id);
      result.push({...file, ownerTabId, parentTabId:parentId, depth});
      visit(file.id, depth + 1);
    }
  };
  if (ownerTabId) visit(ownerTabId, 0);
  return result;
}

const publicationIndexes = new WeakMap();
// Presentation selectors share one scan of the published Zustand state. The
// state object changes on every publication even when producers mutate tabs
// before set(). Do not key this by openProjects: its nested tabs may be mutable.
// Mutation/drag admission readers above deliberately keep their fresh scan.
export function publishedTabLinkedFilesSnapshot(state, ownerTabId) {
  let publication = publicationIndexes.get(state);
  if (!publication) {
    const workflows = new Map();
    for (const space of state.spaces || []) if (!workflows.has(space.id)) workflows.set(space.id, space);
    publication = { byParent: buildLinkedFileIndex(state.openProjects), owners: new Map(), workflows, ranks: new Map() };
    publicationIndexes.set(state, publication);
  }
  if (publication.owners.has(ownerTabId)) return publication.owners.get(ownerTabId);
  const workflowId = state.tabWorkflowMembership?.[ownerTabId]?.workflowId;
  let rank = publication.ranks.get(workflowId);
  if (!rank) {
    rank = new Map((publication.workflows.get(workflowId)?.reserveOrder || []).map((id, index) => [id, index]));
    publication.ranks.set(workflowId, rank);
  }
  const snapshot = JSON.stringify(collectLinkedFileIndex(publication.byParent, ownerTabId, rank));
  publication.owners.set(ownerTabId, snapshot);
  return snapshot;
}

export function linkedFileOwner(openProjects, fileId) {
  const catalog = new Map();
  for (const [projectId, workspace] of openProjects || [])
    for (const tab of workspace.tabs?.values() || []) catalog.set(tab.id, {projectId, tab});
  let entry = catalog.get(fileId);
  const seen = new Set();
  while (entry?.tab.tabType === 'file') {
    if (seen.has(entry.tab.id)) return null;
    seen.add(entry.tab.id);
    entry = catalog.get(entry.tab.visualParentTabId);
  }
  return entry && !entry.tab.archived && !entry.tab.isArchived && !entry.tab.archivedAt && !entry.tab.deleted
    ? {projectId:entry.projectId, tabId:entry.tab.id} : null;
}

export function tabLinkedFilesSnapshot(openProjects, ownerTabId, orderedIds = []) {
  return JSON.stringify(collectTabLinkedFileTree(openProjects, ownerTabId, orderedIds));
}

export function preferredLinkedFile(files, preview, ownerTabId, lastFileId) {
  return files.find(file => isLinkedFilePreview(preview, ownerTabId, file.id, file.projectId))
    || files.find(file => file.id === lastFileId) || files[0];
}

export function isLinkedFilePreview(preview, ownerTabId, fileId, projectId) {
  return preview?.source === 'tab' && preview.ownerTabId === ownerTabId
    && (fileId === undefined || preview.sourceTabId === fileId)
    && (projectId === undefined || preview.sourceProjectId === projectId);
}

export function placeLinkedFilePopup(anchor, popup, viewport, gap = 4) {
  const edge = 8;
  const width = Math.min(popup.width, Math.max(0, viewport.width - edge * 2));
  const below = viewport.height - anchor.bottom - gap - edge;
  const above = anchor.top - gap - edge;
  const flip = popup.height > below && above > below;
  const maxHeight = Math.max(0, flip ? above : below);
  const height = Math.min(popup.height, maxHeight);
  return { left: Math.max(edge, Math.min(anchor.left, viewport.width - width - edge)),
    top: flip ? Math.max(edge, anchor.top - gap - height) : anchor.bottom + gap,
    maxHeight, flip };
}
