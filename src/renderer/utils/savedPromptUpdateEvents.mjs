export function subscribeSavedPromptUpdates(ipcRenderer, onUpdated) {
  const channel = 'prompts:updated';
  const listener = (_event, prompt) => {
    if (prompt && typeof prompt.id === 'string') onUpdated(prompt);
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

export function subscribeSavedPromptLibraryChanges(ipcRenderer, onChanged) {
  const channel = 'prompt-library:changed';
  const listener = (_event, change) => {
    if (change?.library && Array.isArray(change.library.prompts)) onChanged(change);
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// An API mutation can arrive while the picker's initial IPC reads are pending.
// Keep the complete pushed library newer than that earlier read response.
export function createSavedPromptLibraryReceiver(applyLibrary) {
  let generation = 0;
  const valid = (library) => library && Array.isArray(library.prompts) && Array.isArray(library.groups);
  return {
    generation: () => generation,
    receiveChange(change) {
      if (!valid(change?.library)) return false;
      generation += 1;
      applyLibrary(change.library);
      return true;
    },
    receiveLoad(library, startedAtGeneration) {
      if (startedAtGeneration !== generation || !valid(library)) return false;
      applyLibrary(library);
      return true;
    },
  };
}

function samePaths(left, right) {
  const normalizedLeft = Array.isArray(left) ? left : [];
  const normalizedRight = Array.isArray(right) ? right : [];
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export function mergeSavedPromptDraft(saved, draft, updated) {
  return {
    title: draft.title === saved.title ? updated.title : draft.title,
    content: draft.content === saved.content ? updated.content : draft.content,
    file_paths: samePaths(draft.file_paths, saved.file_paths)
      ? (updated.file_paths || [])
      : draft.file_paths,
  };
}

export function applySavedPromptLibraryUpdate(prompts, updatedPrompt) {
  const index = prompts.findIndex((prompt) => prompt.id === updatedPrompt.id);
  if (index < 0) return prompts;
  const next = [...prompts];
  next[index] = { ...next[index], ...updatedPrompt };
  return next;
}

export function reconcileSavedPromptEditor({ prompts, nextPrompts, editingPromptId, draft }) {
  const next = Array.isArray(nextPrompts) ? nextPrompts : prompts;
  if (!editingPromptId) return { prompts: next, editingPromptId: null, editingIndex: null, draft };
  const saved = prompts.find((prompt) => prompt.id === editingPromptId);
  const updated = next.find((prompt) => prompt.id === editingPromptId);
  if (!updated) return { prompts: next, editingPromptId: null, editingIndex: null, draft };
  return {
    prompts: next,
    editingPromptId,
    editingIndex: next.findIndex((prompt) => prompt.id === editingPromptId),
    draft: saved ? mergeSavedPromptDraft(saved, draft, updated) : draft,
  };
}
