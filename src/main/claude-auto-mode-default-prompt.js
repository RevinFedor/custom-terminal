'use strict';

const SELECTED_MARKER_RE = /^\s*[❯›>]/u;
const FOOTER_RE = /Enter\s+to\s+confirm\b.*\bEsc\s+to\s+(?:exit|cancel)\b/i;

function looksLikeClaudeAutoModeDefaultPromptText(text) {
  const compact = String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();
  return compact.includes('makeautomodeyourdefaultpermissionmode?')
    || compact.includes('1.yes,setautomodeasmydefaultpermissionmode')
    || compact.includes('2.no,keepbypasspermissions');
}

function normalizeLine(line) {
  return String(line?.text || line?.rawText || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactText(lines, start, end) {
  return lines
    .slice(start, end)
    .map((line) => line.normalized)
    .join('')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function isSelectedLine(line) {
  return SELECTED_MARKER_RE.test(String(line?.text || line?.rawText || ''))
    || line?.hasInverse === true
    || line?.hasNonDefaultBg === true;
}

function lastContentIndex(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].normalized) return index;
  }
  return -1;
}

/**
 * Recognize only Claude's current onboarding question which offers to replace
 * bypass permissions with Auto mode. The title and both complete choices are
 * required; partial differential paints and old text above a later composer
 * never authorize keyboard input.
 */
function inspectClaudeAutoModeDefaultPromptSnapshot(snapshot) {
  if (
    snapshot?.success !== true
    || snapshot.authoritativeFrameCommitted !== true
    || snapshot.liveSynchronizedOutputOpen === true
    || !Array.isArray(snapshot.lines)
  ) {
    return {
      visible: false,
      selectedOption: null,
      reason: 'committed-frame-required',
    };
  }

  const lines = snapshot.lines.map((line) => ({
    ...line,
    normalized: normalizeLine(line),
  }));
  const lastIndex = lastContentIndex(lines);
  if (lastIndex < 0) {
    return { visible: false, selectedOption: null, reason: 'empty-frame' };
  }

  let yesIndex = -1;
  let noIndex = -1;
  for (let index = 0; index <= lastIndex; index += 1) {
    const text = lines[index].normalized;
    if (/^(?:[❯›>]\s*)?1\.\s*Yes,?\s*set\s+auto\b/i.test(text)) {
      yesIndex = index;
    }
    if (
      yesIndex >= 0
      && index > yesIndex
      && /^(?:[❯›>]\s*)?2\.\s*No,?\s*keep\b/i.test(text)
    ) {
      noIndex = index;
      break;
    }
  }
  if (yesIndex < 0 || noIndex < 0) {
    return { visible: false, selectedOption: null, reason: 'options-missing' };
  }

  let titleStart = -1;
  for (let index = Math.max(0, yesIndex - 12); index < yesIndex; index += 1) {
    const candidate = compactText(lines, index, Math.min(yesIndex, index + 4));
    if (candidate.includes('makeautomodeyourdefaultpermissionmode?')) {
      titleStart = index;
    }
  }
  if (titleStart < 0) {
    return { visible: false, selectedOption: null, reason: 'title-missing' };
  }

  const footerIndex = lines.findIndex((line, index) => (
    index > noIndex && FOOTER_RE.test(line.normalized)
  ));
  if (footerIndex >= 0 && footerIndex !== lastIndex) {
    return { visible: false, selectedOption: null, reason: 'footer-not-current' };
  }
  const optionEnd = footerIndex >= 0 ? footerIndex : lastIndex + 1;
  const yesNeedle = '1.yes,setautomodeasmydefaultpermissionmode';
  let yesCompleteEnd = -1;
  for (let end = yesIndex + 1; end <= noIndex; end += 1) {
    if (compactText(lines, yesIndex, end).includes(yesNeedle)) {
      yesCompleteEnd = end;
      break;
    }
  }
  if (yesCompleteEnd < 0) {
    return { visible: false, selectedOption: null, reason: 'yes-option-incomplete' };
  }
  if (lines.slice(yesCompleteEnd, noIndex).some((line) => line.normalized)) {
    return { visible: false, selectedOption: null, reason: 'yes-option-tail-ambiguous' };
  }
  const noNeedle = '2.no,keepbypasspermissions';
  let noCompleteEnd = -1;
  for (let end = noIndex + 1; end <= optionEnd; end += 1) {
    if (compactText(lines, noIndex, end).includes(noNeedle)) {
      noCompleteEnd = end;
      break;
    }
  }
  if (noCompleteEnd < 0) {
    return { visible: false, selectedOption: null, reason: 'no-option-incomplete' };
  }
  if (lines.slice(noCompleteEnd, optionEnd).some((line) => line.normalized)) {
    return { visible: false, selectedOption: null, reason: 'modal-not-current' };
  }

  const yesLines = lines.slice(yesIndex, noIndex);
  const noLines = lines.slice(noIndex, optionEnd);
  const yesExplicit = yesLines.some((line) => (
    SELECTED_MARKER_RE.test(String(line?.text || line?.rawText || ''))
  ));
  const noExplicit = noLines.some((line) => (
    SELECTED_MARKER_RE.test(String(line?.text || line?.rawText || ''))
  ));
  const useExplicitSelection = yesExplicit !== noExplicit;
  const yesSelected = useExplicitSelection ? yesExplicit : yesLines.some(isSelectedLine);
  const noSelected = useExplicitSelection ? noExplicit : noLines.some(isSelectedLine);
  const selectedOption = yesSelected === noSelected
    ? null
    : (yesSelected ? 1 : 2);
  return {
    visible: true,
    selectedOption,
    reason: selectedOption === null
      ? 'selection-ambiguous'
      : 'current-auto-mode-default-prompt-proven',
  };
}

module.exports = {
  inspectClaudeAutoModeDefaultPromptSnapshot,
  looksLikeClaudeAutoModeDefaultPromptText,
};
