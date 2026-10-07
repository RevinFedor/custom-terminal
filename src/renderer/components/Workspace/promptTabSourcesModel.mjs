// Target is captured when the picker opens, never inferred from the UI focus.
export async function loadPickerPromptCatalog(ipc, { tabId, projectId, organizationReady }) {
  if (organizationReady) {
    if (!tabId) return null;
    const result = await ipc.invoke('project-prompts:list-tab', tabId);
    if (!result?.success) throw new Error(result?.error || 'Unable to load tab prompts');
    return {
      ...result.data,
      project: { id: `tab:${tabId}`, name: 'Промпты вкладки', icon: null },
    };
  }
  if (!projectId) return null;
  const result = await ipc.invoke('project-prompts:list', projectId);
  if (!result?.success) throw new Error(result?.error || 'Unable to load project prompts');
  return result.data;
}

export function promptCatalogChangeAffectsTarget(change, { tabId, projectId, organizationReady }) {
  if (organizationReady) return !Array.isArray(change?.tabIds) || change.tabIds.includes(tabId);
  return !Array.isArray(change?.projectIds) || change.projectIds.includes(projectId);
}

export function promptRootChoices(snapshot) {
  // Removed bound registrations are deliberately absent from the global list.
  // Include them so the current binding remains visible and removable.
  const choices = new Map();
  for (const source of snapshot.sources || []) {
    const id = source.rootId || source.id;
    choices.set(id, { ...source, id, path: source.rootPath || source.path });
  }
  for (const root of snapshot.roots || []) {
    choices.set(root.id, { ...choices.get(root.id), ...root });
  }
  return [...choices.values()];
}

export function togglePromptRoot(rootIds, id, checked) {
  return checked ? (rootIds.includes(id) ? rootIds : [...rootIds, id]) : rootIds.filter(value => value !== id);
}

export function tabPromptBindingRequest(snapshot, tabId, rootIds, mutationId) {
  validatePromptRootSnapshot(snapshot);
  return { tabId, rootIds: [...rootIds], expectedRevision: snapshot.revision, mutationId };
}

export function validatePromptRootSnapshot(snapshot) {
  if (snapshot?.version !== 1 || !Number.isInteger(snapshot.revision)) throw new Error('Unsupported root registry version');
}
