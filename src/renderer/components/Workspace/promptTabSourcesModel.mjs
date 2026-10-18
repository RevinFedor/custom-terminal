import {PROMPT_SOURCE_FOLDER} from '../../../shared/prompt-source-policy.mjs';

export function promptSourceSearchPath(root) {
  const path = typeof root === 'string' ? root : root?.path || root?.rootPath || '';
  return path ? path.replace(/\/+$/, '') + '/' + PROMPT_SOURCE_FOLDER : '';
}

export function promptRootForSelectedFolder(snapshot, folder) {
  const normalized = folder.replace(/\/+$/, '') || '/';
  const roots = snapshot.roots || [];
  // An explicitly registered root always wins, even if its name is docs.
  // Selecting a known root's search folder reuses that root's exact ID;
  // unregistered directories are never silently replaced by their parent.
  return roots.find(root => (root.path.replace(/\/+$/, '') || '/') === normalized)
    || roots.find(root => promptSourceSearchPath(root) === normalized);
}

// Target is captured when the picker opens, never inferred from the UI focus.
export async function loadPickerPromptCatalog(ipc, { tabId, projectId, organizationReady }) {
  if (organizationReady) {
    if (!tabId) return null;
    const result = await ipc.invoke('project-prompts:list-tab', tabId);
    if (!result?.success) throw promptCatalogReadError(result, 'Unable to load tab prompts');
    validatePreparedCatalog(result.data);
    return {
      ...result.data,
      project: { id: `tab:${tabId}`, name: 'Промпты рабочего пространства', icon: null },
    };
  }
  if (!projectId) return null;
  const result = await ipc.invoke('project-prompts:list', projectId);
  if (!result?.success) throw promptCatalogReadError(result, 'Unable to load project prompts');
  validatePreparedCatalog(result.data);
  return result.data;
}

export function promptCatalogReadError(result, fallback = 'Prompt catalog unavailable') {
  const error = new Error(result?.error || result?.message || fallback);
  error.code = result?.code || 'prompt_catalog_unavailable';
  return error;
}

function validatePreparedCatalog(data) {
  if (!data || typeof data.then === 'function' || !Array.isArray(data.prompts) || !Array.isArray(data.sources))
    throw promptCatalogReadError(null, 'Invalid prepared prompt catalog');
}

export async function loadPromptCatalogUsage(ipc, rootPath) {
  const result = await ipc.invoke('project-prompts:usage-for-root', rootPath);
  if (!result?.success) throw promptCatalogReadError(result);
  if (!Array.isArray(result.data)) throw promptCatalogReadError(null, 'Invalid prepared prompt usage');
  return result.data;
}

export function preparedCatalogStatusText(state) {
  if (state.status === 'ready') return '';
  if (state.status === 'stale' || state.error?.code === 'prompt_catalog_changed') return 'Промпты обновляются…';
  if (state.status === 'cold' || state.status === 'preparing') return 'Промпты подготавливаются…';
  return 'Промпты недоступны';
}

// UI observation only: no bodies, readiness polling or independent authority.
// Invalidation synchronously retires the old sequence before a React commit.
// No authority stamp exists in the literal DTO, so old rows are not retained
// as selectable (or displayed as last-good after unknown binding changes).
export function createPreparedCatalogReceiver({targetKey, read, onState, isCurrent = () => true}) {
  let closed = false, sequence = 0, inflight = false, requested = false;
  let hadReady = false;
  let state = {targetKey, sequence, status:'cold', data:null, error:null};
  const current = () => !closed && isCurrent();
  const publish = next => { state = next; if (current()) onState(state); };
  const run = async () => {
    if (inflight || !requested || !current()) return;
    requested = false; inflight = true;
    const token = sequence;
    try {
      const data = await read();
      if (!current() || token !== sequence) return;
      hadReady = true;
      publish({targetKey, sequence, status:'ready', data, error:null});
    } catch (failure) {
      if (!current() || token !== sequence) return;
      const error = failure instanceof Error ? failure : promptCatalogReadError(failure);
      const preparing = ['prompt_catalog_preparing','prompt_catalog_changed'].includes(error.code);
      publish({targetKey, sequence, status:preparing ? (hadReady ? 'stale' : 'preparing') : 'failed', data:null, error});
    } finally {
      inflight = false;
      // A newer event coalesces behind this read; a preparing result alone
      // never creates a retry/waiter. Only a new event requests another read.
      if (requested && current()) void run();
    }
  };
  return {
    refresh() {
      if (!current()) return;
      sequence++; requested = true;
      publish({targetKey, sequence, status:hadReady ? 'stale' : 'preparing', data:null, error:null});
      void run();
    },
    state: () => state,
    canSelect: token => current() && state.status === 'ready' && sequence === token,
    close() { closed = true; sequence++; requested = false; },
  };
}

export function observePreparedPromptCatalog({ipc, targetKey, read, acceptsChange, onState, isCurrent}) {
  const receiver = createPreparedCatalogReceiver({targetKey, read, onState, isCurrent});
  const changed = (_event, change) => { if (acceptsChange(change)) receiver.refresh(); };
  // The first invoke may itself coincide with a publication.
  ipc.on('project-prompts:changed', changed);
  receiver.refresh();
  return {receiver, close() { receiver.close(); ipc.removeListener('project-prompts:changed', changed); }};
}

export function promptUsageChangeAffectsTarget(change) {
  if (Array.isArray(change?.tabIds)) return change.tabIds.length > 0;
  if (Array.isArray(change?.projectIds)) return change.projectIds.length > 0;
  return true;
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
