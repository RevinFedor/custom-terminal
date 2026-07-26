'use strict';

const PICKER_MARKER_RE = /^\s*[●❯›]\s*/u;
const MORE_ABOVE_RE = /^↑\s*\d+\s*more\s*above$/i;
const MORE_BELOW_RE = /^↓\s*\d+\s*more\s*below$/i;
const FOOTER_RE = /^Enter\s+to\s+continue\b.*\bEsc\s+to\s+cancel\b/i;

function normalizeClaudeRewindMenuText(line) {
  return String(line?.text || line?.rawText || '')
    .replace(/\u00a0/g, ' ')
    .replace(PICKER_MARKER_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inactiveScope(reason, extra = {}) {
  return {
    scopedLines: [],
    scopeFound: false,
    scopeStartRow: null,
    scopeEndRow: null,
    hasMoreAbove: false,
    hasMoreBelow: false,
    reason,
    ...extra,
  };
}

/**
 * Locate only the currently active Claude /rewind picker.
 *
 * The lower "↓ N more below" row is an end boundary, never a new header.
 * The footer must be the last visible non-empty row so an old picker left in
 * scrollback cannot authorize Enter in the ordinary composer/history surface.
 */
function inspectClaudeRewindMenuScope(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return inactiveScope('empty-frame');
  }

  const normalized = lines.map((line) => normalizeClaudeRewindMenuText(line));
  let lastContentIndex = -1;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (normalized[index]) {
      lastContentIndex = index;
      break;
    }
  }
  if (lastContentIndex < 0) return inactiveScope('empty-frame');

  let footerIndex = -1;
  for (let index = lastContentIndex; index >= 0; index -= 1) {
    if (FOOTER_RE.test(normalized[index])) {
      footerIndex = index;
      break;
    }
  }
  if (footerIndex < 0) return inactiveScope('footer-missing');
  if (footerIndex !== lastContentIndex) {
    return inactiveScope('footer-not-current', { footerIndex, lastContentIndex });
  }

  let titleIndex = -1;
  let subtitleIndex = -1;
  let moreAboveIndex = -1;
  const moreBelowIndexes = [];
  for (let index = 0; index < footerIndex; index += 1) {
    const text = normalized[index];
    if (text === 'Rewind') titleIndex = index;
    if (text.startsWith('Restore and fork')) subtitleIndex = index;
    if (MORE_ABOVE_RE.test(text)) moreAboveIndex = index;
    if (MORE_BELOW_RE.test(text)) moreBelowIndexes.push(index);
  }

  const startBoundaryIndex = Math.max(titleIndex, subtitleIndex, moreAboveIndex);
  const hasMoreAbove = moreAboveIndex >= 0;
  const hasMoreBelow = moreBelowIndexes.length > 0;
  if (startBoundaryIndex < 0 && !hasMoreBelow) {
    return inactiveScope('menu-anchor-missing', {
      footerIndex,
      lastContentIndex,
    });
  }

  const startIndex = startBoundaryIndex >= 0 ? startBoundaryIndex + 1 : 0;
  const moreBelowIndex = moreBelowIndexes.find((index) => index >= startIndex);
  const endIndex = Number.isInteger(moreBelowIndex) ? moreBelowIndex : footerIndex;
  if (endIndex < startIndex) {
    return inactiveScope('invalid-menu-range', {
      footerIndex,
      lastContentIndex,
      hasMoreAbove,
      hasMoreBelow,
    });
  }

  const scopedLines = lines.slice(startIndex, endIndex);
  return {
    scopedLines,
    scopeFound: true,
    scopeStartRow: Number.isFinite(scopedLines[0]?.row) ? scopedLines[0].row : null,
    scopeEndRow: Number.isFinite(scopedLines[scopedLines.length - 1]?.row)
      ? scopedLines[scopedLines.length - 1].row
      : null,
    hasMoreAbove,
    hasMoreBelow,
    reason: startBoundaryIndex >= 0 ? 'anchored-current-menu' : 'clipped-current-menu',
    startIndex,
    endIndex,
    footerIndex,
  };
}

function authorizeClaudeRewindTargetSelection({
  menuScopeFound = false,
  selectedText = '',
  selectedMatchesTarget = false,
  targetBeforeSelected = false,
  selectedIsSlashCommand = false,
} = {}) {
  if (!menuScopeFound) {
    return { matchedTarget: false, reason: 'rewind-menu-not-proven' };
  }
  if (selectedMatchesTarget) {
    if (!String(selectedText || '').trim()) {
      return { matchedTarget: false, reason: 'selected-row-missing' };
    }
    return { matchedTarget: true, reason: 'current-menu-selected-target' };
  }
  if (targetBeforeSelected) {
    if (selectedIsSlashCommand) {
      return { matchedTarget: false, reason: 'target-before-selected-control-row' };
    }
    return { matchedTarget: true, reason: 'current-menu-target-before-selected' };
  }
  if (!String(selectedText || '').trim()) {
    return { matchedTarget: false, reason: 'selected-row-missing' };
  }
  return { matchedTarget: false, reason: 'selected-row-target-mismatch' };
}

function findClaudeRewindPrimarySelectedLine(lines) {
  if (!Array.isArray(lines)) return null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const rawText = String(line?.rawText || line?.text || '');
    if (PICKER_MARKER_RE.test(rawText)
      || line?.hasInverse === true
      || line?.hasNonDefaultBg === true) {
      return line;
    }
  }
  return null;
}

module.exports = {
  authorizeClaudeRewindTargetSelection,
  findClaudeRewindPrimarySelectedLine,
  inspectClaudeRewindMenuScope,
  normalizeClaudeRewindMenuText,
};
