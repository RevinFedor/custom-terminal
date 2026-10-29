'use strict';

const RESUME_GOAL_TITLE_RE = /Resume\s+paused\s+goal\?/gi;
const RESUME_GOAL_FOOTER_RE = /\b(?:Press enter to confirm or esc to go back|enter\s+select\s*·\s*esc\s+back)$/i;
const RESUME_GOAL_FIRST_SELECTED_RE = /^[\t ]*[›❯»>][\t ]*1\.[\t ]*Resume\s+goal\b/im;
const RESUME_GOAL_SECOND_SELECTED_RE = /^[\t ]*[›❯»>][\t ]*2\.[\t ]*Leave\s+paused\b/im;

function resolveCodexResumeGoalPreference(override, configured) {
  // Absence is a manual choice, not an implicit authorization to resume a
  // persisted native Goal. Existing explicit booleans retain their meaning.
  return typeof override === 'boolean' ? override : typeof configured === 'boolean' ? configured : null;
}

function normalizeCodexResumeGoalText(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\u00a0/g, ' ');
}

function hasInsetGoalBody(text, titleIndex) {
  // The CLI paints an inset picker over its composer without erasing the
  // underlay to the left. Read the picker column, not arbitrary leading prose.
  const start = text.lastIndexOf('\n', titleIndex - 1) + 1;
  const margin = text.slice(start, titleIndex);
  if (!/^ +$/.test(margin)) return false;
  const column = margin.length;
  const lines = text.slice(titleIndex).split(/\r?\n/).slice(1);
  const body = lines.find(line => line.trim());
  if (!body || !/^Goal:[\t ]*\S/.test(body.slice(column))) return false;
  const aligned = (index, label) => lines.some(line => {
    const prefix = /^[ ]*(?:[›❯»>][ ]*)?[12]\./.exec(line)?.[0];
    return prefix && prefix.length - 2 === column
      && line.slice(column).startsWith(index + '. ' + label);
  });
  return aligned(1, 'Resume goal') && aligned(2, 'Leave paused');
}

function inspectCodexResumeGoalPrompt(cleanText) {
  const text = normalizeCodexResumeGoalText(cleanText);
  const titleIndex = [...text.matchAll(RESUME_GOAL_TITLE_RE)].at(-1)?.index ?? -1;
  if (titleIndex < 0) {
    return {
      visible: false,
      interactiveVisible: false,
      canAutoEnter: false,
      firstOptionSelected: false,
      secondOptionSelected: false,
      missing: ['title'],
      skipReason: 'not-visible',
    };
  }

  // Scope every proof to the latest title. Older modal text may remain in
  // scrollback, but it must never authorize Enter on a newer composer/frame.
  const section = text.slice(titleIndex);
  const compact = section.replace(/\s+/g, ' ').trim();
  const firstOptionSelected = RESUME_GOAL_FIRST_SELECTED_RE.test(section);
  const secondOptionSelected = RESUME_GOAL_SECOND_SELECTED_RE.test(section);
  const checks = {
    title: true,
    // Codex 0.162 may prefix the description with › as well as the option.
    // Keep that decoration local: it must not count as a selected menu item.
    goal: /(?:^|\n)[\t ]*(?:›[\t ]+)?Goal:[\t ]*\S/im.test(section)
      || hasInsetGoalBody(text, titleIndex),
    resumeOption: /(?:^|\n)[\t ]*(?:[›❯»>][\t ]*)?1\.[\t ]*Resume\s+goal\b/im.test(section),
    resumeDescription: /Mark it active and continue when idle/i.test(compact),
    leaveOption: /(?:^|\n)[\t ]*(?:[›❯»>][\t ]*)?2\.[\t ]*Leave\s+paused\b/im.test(section),
    leaveDescription: /Keep it paused; use \/goal resume later/i.test(compact),
    footer: RESUME_GOAL_FOOTER_RE.test(compact),
  };
  const missing = Object.entries(checks)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  const visible = checks.title;
  const interactiveVisible = visible && missing.length === 0;
  const canAutoEnter = interactiveVisible
    && firstOptionSelected
    && !secondOptionSelected;

  let skipReason = null;
  if (secondOptionSelected) skipReason = 'leave-paused-selected';
  else if (!firstOptionSelected) skipReason = 'resume-goal-not-selected';
  else if (missing.length > 0) skipReason = 'missing:' + missing.join(',');

  return {
    visible,
    titleIndex,
    interactiveVisible,
    canAutoEnter,
    firstOptionSelected,
    secondOptionSelected,
    missing,
    skipReason,
  };
}

function projectCodexResumeGoalPaintedDialog(terminal, snapshot, text) {
  const unavailable = reason => ({ projected: false, reason });
  if (!/Resume\s+paused\s+goal\?/i.test(text)) return unavailable('no-goal-dialog');
  const inspected = inspectCodexResumeGoalPrompt(text);
  if (!inspected.interactiveVisible || inspected.firstOptionSelected === inspected.secondOptionSelected) {
    return unavailable('not-complete-goal');
  }
  try {
    const buffer = terminal?.buffer?.active;
    const rows = snapshot?.lines;
    if (!buffer || !Array.isArray(rows) || snapshot.cols !== terminal.cols
      || snapshot.rows !== terminal.rows || snapshot.viewportY !== buffer.viewportY) {
      return unavailable('snapshot-geometry-unavailable');
    }
    const title = rows.findLastIndex(line => /Resume\s+paused\s+goal\?/i.test(line.text));
    const titleColumn = title < 0 ? -1 : rows[title].text.search(/Resume\s+paused\s+goal\?/i);
    if (titleColumn < 0 || !/^ *$/.test(rows[title].text.slice(0, titleColumn))) {
      return unavailable('goal-origin-unproven');
    }
    const footer = rows.findLastIndex((line, index) => index > title
      && RESUME_GOAL_FOOTER_RE.test(line.text.trim()));
    const options = [1, 2].map(number => rows.flatMap((line, index) => {
      if (index <= title || index >= footer) return [];
      const pattern = number === 1
        ? /^[ ]*(?:[›❯»>][ ]*)?1\.[ ]*Resume\s+goal\b/i
        : /^[ ]*(?:[›❯»>][ ]*)?2\.[ ]*Leave\s+paused\b/i;
      return pattern.test(line.text) && line.text.indexOf(number + '.') === titleColumn ? [index] : [];
    }));
    if (footer < 0 || options.some(matches => matches.length !== 1) || options[0][0] >= options[1][0]) {
      return unavailable('goal-controls-unproven');
    }
    const physical = new Map();
    for (let index = title; index <= footer; index++) {
      const row = rows[index];
      const line = Number.isSafeInteger(row.row) && buffer.getLine(row.row);
      if (!line || line.translateToString(true) !== row.text) return unavailable('snapshot-text-changed');
      physical.set(index, line);
    }
    const bg = cell => cell && typeof cell.getBgColorMode === 'function'
      && cell.getBgColorMode() !== 0 ? cell.getBgColorMode() + ':' + cell.getBgColor() : null;
    const bands = options.map(([index]) => {
      const line = physical.get(index), color = bg(line.getCell(titleColumn));
      if (!color) return null;
      let left = titleColumn, right = titleColumn + 1;
      while (left > 0 && bg(line.getCell(left - 1)) === color) left--;
      while (right < terminal.cols && bg(line.getCell(right)) === color) right++;
      return { left, right, color };
    });
    if (!bands[0] || !bands[1] || bands[0].left !== bands[1].left || bands[0].right !== bands[1].right) {
      return unavailable('goal-paint-bounds-unproven');
    }
    const { left, right } = bands[0];
    const bodyColor = bands[inspected.firstOptionSelected ? 1 : 0].color;
    // Both native control rows independently delimit the painted panel. Keep
    // ALL Goal content inside it, not a guessed width or a whitespace prefix.
    // The native underlay may remain visible outside either edge during restore.
    for (let index = title; index < options[0][0]; index++) {
      const line = physical.get(index);
      if (!line.translateToString(true, left, right).trim()) continue;
      for (let x = left; x < right; x++) {
        if (bg(line.getCell(x)) !== bodyColor) return unavailable('goal-body-paint-unproven');
      }
    }
    const clipped = [];
    for (let index = title; index <= footer; index++) {
      const line = physical.get(index);
      if (line.getCell(left)?.getWidth() === 0
        || (right < terminal.cols && line.getCell(right)?.getWidth() === 0)) {
        return unavailable('goal-paint-splits-cell');
      }
      clipped.push(line.translateToString(true, left, right));
    }
    const projectedText = clipped.join('\n'), projected = inspectCodexResumeGoalPrompt(projectedText);
    if (!projected.interactiveVisible || projected.firstOptionSelected !== inspected.firstOptionSelected
      || projected.secondOptionSelected !== inspected.secondOptionSelected) {
      return unavailable('painted-goal-controls-mismatch');
    }
    return { projected: true, text: projectedText,
      bounds: { left, right, top: rows[title].row, bottom: rows[footer].row + 1 } };
  } catch {
    return unavailable('goal-paint-unavailable');
  }
}

function decideCodexResumeGoalAutoEnter({
  sameTerminal,
  sameRunSeq,
  sameInputRevision,
  screenAvailable,
  cleanText,
} = {}) {
  if (sameTerminal !== true) return { allowed: false, reason: 'terminal-changed' };
  if (sameRunSeq !== true) return { allowed: false, reason: 'run-changed' };
  if (sameInputRevision !== true) return { allowed: false, reason: 'input-changed' };
  if (screenAvailable !== true) return { allowed: false, reason: 'screen-unavailable' };
  const prompt = inspectCodexResumeGoalPrompt(cleanText);
  if (!prompt.visible) return { allowed: false, reason: 'prompt-closed', prompt };
  if (!prompt.canAutoEnter) {
    return {
      allowed: false,
      reason: prompt.skipReason || 'prompt-not-confirmed',
      prompt,
    };
  }
  return { allowed: true, reason: 'resume-goal-selected', prompt };
}

function decideCodexLeaveGoalPausedAutoEnter({
  sameTerminal,
  sameRunSeq,
  sameInputRevision,
  screenAvailable,
  cleanText,
} = {}) {
  if (sameTerminal !== true) return { allowed: false, reason: 'terminal-changed' };
  if (sameRunSeq !== true) return { allowed: false, reason: 'run-changed' };
  if (sameInputRevision !== true) return { allowed: false, reason: 'input-changed' };
  if (screenAvailable !== true) return { allowed: false, reason: 'screen-unavailable' };
  const prompt = inspectCodexResumeGoalPrompt(cleanText);
  if (!prompt.visible) return { allowed: false, reason: 'prompt-closed', prompt };
  if (!prompt.interactiveVisible || !prompt.secondOptionSelected || prompt.firstOptionSelected) {
    return {
      allowed: false,
      reason: prompt.skipReason || 'leave-paused-not-selected',
      prompt,
    };
  }
  return { allowed: true, reason: 'leave-paused-selected', prompt };
}

module.exports = {
  resolveCodexResumeGoalPreference,
  decideCodexLeaveGoalPausedAutoEnter,
  decideCodexResumeGoalAutoEnter,
  inspectCodexResumeGoalPrompt,
  projectCodexResumeGoalPaintedDialog,
};
