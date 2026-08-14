'use strict';

const THINK_TITLE_RE = /Toggle\s+thinking\s+mode/i;
const THINK_FOOTER_RE = /Enter\s+to\s+confirm\b.*\bEsc\s+to\s+(?:exit|cancel)\b/i;
const PROCEED_TITLE_RE = /Do\s+you\s+want\s+to\s+proceed\?/i;
const SELECTED_MARKER_RE = /^\s*[❯›>]/u;

function normalizeLine(line) {
  return String(line?.text || line?.rawText || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function currentFrameLines(snapshot) {
  if (snapshot?.success !== true || !Array.isArray(snapshot.lines)) return [];
  return snapshot.lines.map((line) => ({
    ...line,
    normalized: normalizeLine(line),
  }));
}

function lastContentIndex(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].normalized) return index;
  }
  return -1;
}

function optionState(line) {
  const text = line?.normalized || '';
  if (/\bEnabled\b/i.test(text)) return true;
  if (/\bDisabled\b/i.test(text)) return false;
  return null;
}

function isSelectedLine(line) {
  return SELECTED_MARKER_RE.test(String(line?.text || line?.rawText || ''))
    || line?.hasInverse === true
    || line?.hasNonDefaultBg === true;
}

/**
 * Inspect only the currently visible Claude Think picker. The footer must be
 * the final non-empty row, so old picker text in scrollback cannot authorize
 * Arrow or Enter in the ordinary composer.
 */
function inspectClaudeThinkingPickerSnapshot(snapshot) {
  const lines = currentFrameLines(snapshot);
  const lastIndex = lastContentIndex(lines);
  if (lastIndex < 0) {
    return {
      visible: false,
      modalPresent: false,
      stateKnown: false,
      thinking: null,
      selectedThinking: null,
      reason: 'empty-frame',
    };
  }

  const footerIndex = lines.findLastIndex((line) => THINK_FOOTER_RE.test(line.normalized));
  const titleIndex = lines.findLastIndex((line) => THINK_TITLE_RE.test(line.normalized));
  const enabledIndex = lines.findIndex((line, index) => (
    index > titleIndex && /\bEnabled\b/i.test(line.normalized)
  ));
  const disabledIndex = lines.findIndex((line, index) => (
    index > titleIndex && /\bDisabled\b/i.test(line.normalized)
  ));
  const ordinaryPromptAfterTitle = titleIndex >= 0
    && lines.slice(titleIndex + 1, lastIndex + 1).some((line) => (
      SELECTED_MARKER_RE.test(String(line?.text || line?.rawText || ''))
      && optionState(line) === null
    ));
  const modalPresent = titleIndex >= 0
    && ordinaryPromptAfterTitle !== true
    && (footerIndex < 0 || footerIndex === lastIndex);
  if (footerIndex < 0 || footerIndex !== lastIndex) {
    return {
      visible: false,
      modalPresent,
      stateKnown: false,
      thinking: null,
      selectedThinking: null,
      reason: footerIndex < 0 ? 'footer-missing' : 'footer-not-current',
    };
  }

  if (titleIndex < 0 || (enabledIndex < 0 && disabledIndex < 0)) {
    return {
      visible: false,
      modalPresent,
      stateKnown: false,
      thinking: null,
      selectedThinking: null,
      reason: 'picker-anchor-missing',
    };
  }

  const optionLines = lines
    .slice(0, footerIndex)
    .filter((line) => optionState(line) !== null);
  const checked = optionLines.filter((line) => /✔/u.test(line.normalized));
  const explicitlySelected = optionLines.filter((line) => (
    SELECTED_MARKER_RE.test(String(line?.text || line?.rawText || ''))
  ));
  const selected = explicitlySelected.length > 0
    ? explicitlySelected
    : optionLines.filter(isSelectedLine);
  return {
    visible: true,
    modalPresent: true,
    stateKnown: enabledIndex >= 0 && disabledIndex >= 0 && checked.length === 1,
    thinking: checked.length === 1 ? optionState(checked[0]) : null,
    selectedThinking: selected.length === 1 ? optionState(selected[0]) : null,
    reason: enabledIndex < 0 || disabledIndex < 0
      ? 'options-incomplete'
      : checked.length !== 1
        ? 'checked-option-ambiguous'
        : 'current-picker-proven',
  };
}

function inspectClaudeThinkingProceedSnapshot(snapshot) {
  const lines = currentFrameLines(snapshot);
  const lastIndex = lastContentIndex(lines);
  if (lastIndex < 0) return { visible: false, reason: 'empty-frame' };
  const titleIndex = lines.findLastIndex((line) => PROCEED_TITLE_RE.test(line.normalized));
  if (titleIndex < 0) return { visible: false, reason: 'title-missing' };
  const footerIndex = lines.findLastIndex((line) => THINK_FOOTER_RE.test(line.normalized));
  if (footerIndex >= 0 && footerIndex !== lastIndex) {
    return { visible: false, reason: 'footer-not-current' };
  }
  if (footerIndex < 0) {
    const options = lines.slice(titleIndex + 1, lastIndex + 1);
    const hasYes = options.some((line) => /\bYes\b/i.test(line.normalized));
    const hasNo = options.some((line) => /\bNo\b/i.test(line.normalized));
    const hasSelection = options.some(isSelectedLine);
    if (!hasYes || !hasNo || !hasSelection) {
      return { visible: false, reason: 'dialog-options-missing' };
    }
  }
  return { visible: true, reason: 'current-proceed-dialog-proven' };
}

module.exports = {
  inspectClaudeThinkingPickerSnapshot,
  inspectClaudeThinkingProceedSnapshot,
};
