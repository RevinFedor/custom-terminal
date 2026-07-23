export function buildProjectScriptRows(packageJsonContent, shFiles) {
  const rows = [];

  try {
    const parsed = packageJsonContent ? JSON.parse(packageJsonContent) : null;
    const scripts = parsed && typeof parsed.scripts === 'object' ? parsed.scripts : null;
    if (scripts) {
      for (const name of Object.keys(scripts)) {
        if (!name || name.startsWith('_')) continue;
        rows.push({
          id: `npm:${name}`,
          label: `npm run ${name}`,
          text: `npm run ${name}`,
        });
      }
    }
  } catch {
    // A malformed/missing package.json simply contributes no npm rows. The
    // caller can still show .sh scripts from the same directory.
  }

  const seen = new Set();
  for (const rawFile of Array.isArray(shFiles) ? shFiles : []) {
    const file = String(rawFile || '').trim();
    if (!file || !file.endsWith('.sh') || file.startsWith('.') || seen.has(file)) continue;
    seen.add(file);
    rows.push({
      id: `sh:${file}`,
      label: `./${file}`,
      text: `./${file}`,
    });
  }

  return rows;
}

export function joinPromptInsertionText(promptContent, fileContents) {
  return [promptContent, ...(Array.isArray(fileContents) ? fileContents : [])]
    .map((part) => String(part || ''))
    .filter((part) => part.length > 0)
    .join('\n\n');
}

export function appendHistoryDraftInsertion(currentDraft, insertion) {
  return String(currentDraft || '') + String(insertion || '');
}

export function resolveHistoryScriptCwd(liveCwd, capturedCwd) {
  const live = typeof liveCwd === 'string' ? liveCwd : '';
  if (live.trim()) return live;
  const captured = typeof capturedCwd === 'string' ? capturedCwd : '';
  return captured.trim() ? captured : '';
}

export function isCurrentPickerGeneration(startedGeneration, activeGeneration) {
  return Number.isInteger(startedGeneration)
    && startedGeneration > 0
    && startedGeneration === activeGeneration;
}
