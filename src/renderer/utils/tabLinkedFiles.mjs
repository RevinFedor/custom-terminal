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

export function tabLinkedFilesSnapshot(openProjects, ownerTabId) {
  return JSON.stringify(collectTabLinkedFiles(openProjects, ownerTabId));
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
