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

export function clampFloatingPanelTop(anchorTop, panelHeight, viewportHeight, margin = 8) {
  const safeMargin = Math.max(0, Number(margin) || 0);
  const safeViewportHeight = Math.max(0, Number(viewportHeight) || 0);
  const safePanelHeight = Math.max(0, Number(panelHeight) || 0);
  const minTop = safeMargin;
  const maxTop = Math.max(minTop, safeViewportHeight - safeMargin - safePanelHeight);
  return Math.min(Math.max(Number(anchorTop) || 0, minTop), maxTop);
}

export function captureHistoryMenuAnchor({
  pointerX,
  pointerY,
  composerTop,
} = {}) {
  const x = Number.isFinite(Number(pointerX)) ? Number(pointerX) : 0;
  const y = Number.isFinite(Number(pointerY)) ? Number(pointerY) : 0;
  if (typeof composerTop === 'number' && Number.isFinite(composerTop)) {
    return { mode: 'history-composer', x, y: composerTop };
  }
  return { mode: 'point', x, y };
}

/**
 * Chooses the horizontal direction for the entire context-menu chain once,
 * when the root opens. `descendantWidth` is the maximum width of every panel
 * after the root, so later hover changes cannot make the chain flip sides.
 */
export function chooseContextMenuOpenLeft({
  anchorX,
  viewportWidth,
  rootWidth,
  descendantWidth,
  margin = 8,
} = {}) {
  const safeMargin = Math.max(0, Number(margin) || 0);
  const safeViewport = Math.max(0, Number(viewportWidth) || 0);
  const safeRoot = Math.max(0, Number(rootWidth) || 0);
  const safeDescendants = Math.max(0, Number(descendantWidth) || 0);
  const maxRootLeft = Math.max(safeMargin, safeViewport - safeMargin - safeRoot);
  const rootLeft = Math.min(
    Math.max((Number(anchorX) || 0) + 2, safeMargin),
    maxRootLeft,
  );
  const spaceRight = safeViewport - (rootLeft + safeRoot) - safeMargin;
  const spaceLeft = rootLeft - safeMargin;
  return spaceRight < safeDescendants && spaceLeft > spaceRight;
}
