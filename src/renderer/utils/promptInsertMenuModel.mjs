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

export function promptHasFileReferences(prompt) {
  const paths = prompt && Array.isArray(prompt.file_paths) ? prompt.file_paths : [];
  return paths.some((path) => String(path || '').trim().length > 0);
}

/**
 * Cmd-pick is deliberately a plain-text path insertion, not a saved prompt
 * attachment and not an agent-specific @mention. Keep each file on its own
 * line so multiple attached files remain individually readable and editable.
 */
export function buildPromptFilePathText(filePaths) {
  return (Array.isArray(filePaths) ? filePaths : [])
    .map((path) => String(path || ''))
    .filter((path) => path.trim().length > 0)
    .join('\n');
}

/**
 * A macOS `/Users/...` path at the first visible composer position looks like
 * a slash command to the shared composer guard. Prefix only that exact,
 * case-sensitive path shape with `~`; paths inserted after real text must stay
 * byte-for-byte unchanged.
 */
export function protectLeadingMacUsersPath(pathText, precedingText = '') {
  const text = String(pathText || '');
  if (!text.startsWith('/Users/')) return text;
  return String(precedingText || '').trim().length === 0 ? `~${text}` : text;
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
} = {}) {
  const x = Number.isFinite(Number(pointerX)) ? Number(pointerX) : 0;
  const y = Number.isFinite(Number(pointerY)) ? Number(pointerY) : 0;
  return { mode: 'point', x, y };
}

/**
 * Places a menu next to a viewport-relative pointer without ever letting the
 * pointer land inside the menu. Horizontal direction is chosen by the caller
 * once for the whole chain. Vertically, the menu keeps either its top or
 * bottom edge next to the pointer; if neither side fits, the larger side wins
 * and the caller constrains the panel to `availableHeight`.
 */
export function placePointAnchoredMenu({
  anchorX,
  anchorY,
  panelWidth,
  panelHeight,
  viewportWidth,
  viewportHeight,
  openLeft = false,
  margin = 8,
  gap = 2,
} = {}) {
  const safeMargin = Math.max(0, Number(margin) || 0);
  const safeGap = Math.max(0, Number(gap) || 0);
  const safeViewportWidth = Math.max(0, Number(viewportWidth) || 0);
  const safeViewportHeight = Math.max(0, Number(viewportHeight) || 0);
  const safeWidth = Math.max(0, Number(panelWidth) || 0);
  const safeHeight = Math.max(0, Number(panelHeight) || 0);
  const x = Number(anchorX) || 0;
  const y = Number(anchorY) || 0;

  const maxLeft = Math.max(safeMargin, safeViewportWidth - safeMargin - safeWidth);
  const desiredLeft = openLeft
    ? x - safeGap - safeWidth
    : x + safeGap;
  const left = Math.min(Math.max(desiredLeft, safeMargin), maxLeft);

  const spaceBelow = Math.max(0, safeViewportHeight - safeMargin - y - safeGap);
  const spaceAbove = Math.max(0, y - safeGap - safeMargin);
  const openUp = safeHeight > spaceBelow
    && (safeHeight <= spaceAbove || spaceAbove > spaceBelow);
  const availableHeight = openUp ? spaceAbove : spaceBelow;
  const fittedHeight = Math.min(safeHeight, availableHeight);
  const desiredTop = openUp
    ? y - safeGap - fittedHeight
    : y + safeGap;
  const maxTop = Math.max(
    safeMargin,
    safeViewportHeight - safeMargin - fittedHeight,
  );
  const top = Math.min(Math.max(desiredTop, safeMargin), maxTop);

  return {
    left,
    top,
    openUp,
    availableHeight,
  };
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

/**
 * Keyboard movement and the visible chevron must follow the side where the
 * child panel actually opens. The row layout does not mirror: the chevron
 * remains in the trailing slot and only changes direction.
 */
export function resolveCascadingMenuDirection(opensLeft) {
  return opensLeft
    ? { forwardKey: 'ArrowLeft', backKey: 'ArrowRight', chevron: 'left' }
    : { forwardKey: 'ArrowRight', backKey: 'ArrowLeft', chevron: 'right' };
}
