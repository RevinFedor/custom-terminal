const directory = value => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text && !text.startsWith('/')) throw new Error('Укажите абсолютный путь к директории.');
  return text ? text.replace(/\/+$/, '') || '/' : null;
};

export function normalizeWorkflowDirectories(value) {
  if (value.promptDirectories != null && !Array.isArray(value.promptDirectories))
    throw new Error('Не удалось прочитать дополнительные директории.');
  if((value.promptDirectories || []).some(path=>typeof path!=='string'))
    throw new Error('Не удалось прочитать дополнительные директории.');
  const defaultCwd = directory(value.defaultCwd);
  const promptDirectories = [...new Set((value.promptDirectories || []).map(directory).filter(path => path && path !== defaultCwd))];
  return {defaultCwd, promptDirectories};
}

/** One pending save for the settings draft; close joins it and drains newer edits. */
export function createWorkflowDirectoryDraft({initial, apply, commit}) {
  const normalized=normalizeWorkflowDirectories(initial);
  let draft = {...initial, promptDirectories: [...(initial.promptDirectories || [])]};
  let saved = JSON.stringify(normalized), flight = null;
  return {
    get: () => ({...draft, promptDirectories: [...draft.promptDirectories]}),
    edit(patch) { draft = {...draft, ...patch}; },
    flush() {
      if (flight) return flight;
      const run = async () => {
        for (;;) {
          const next = normalizeWorkflowDirectories(draft), signature = JSON.stringify(next);
          if (signature === saved) return;
          apply(next);
          await commit();
          saved = signature;
        }
      };
      flight = Promise.resolve().then(run).finally(() => { flight = null; });
      return flight;
    },
  };
}
