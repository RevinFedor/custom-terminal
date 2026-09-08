'use strict';

function normalizeLineText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[▌█]/g, '')
    .trimEnd();
}

function readCodexComposerDraft(snapshot) {
  const draft = snapshot?.codexCursorComposer?.hasDraft === true
    ? normalizeLineText(snapshot.codexCursorComposer.text).trim()
    : '';
  return draft;
}

function parseSlashCommandToken(value) {
  const match = String(value || '').trim().match(/^\/([a-z][a-z0-9_-]*)$/i);
  return match ? ('/' + match[1].toLowerCase()) : null;
}

/**
 * Codex paints slash-command completion rows below the live composer. While
 * that surface is open it owns Ctrl+G, so the external-editor binding never
 * runs. A history row containing `/compact` is not enough: the classifier
 * requires the current cursor-owned composer plus a styled command/description
 * row physically below it in the same committed frame.
 */
function inspectCodexSlashCompletionSnapshot(snapshot) {
  if (snapshot?.success !== true) {
    return {
      visible: false,
      draftText: '',
      promptRow: null,
      suggestionRows: [],
      reason: snapshot?.error || 'snapshot-unavailable',
    };
  }

  const draftText = readCodexComposerDraft(snapshot);
  const commandPrefix = parseSlashCommandToken(draftText);
  const promptRow = Number(snapshot?.codexCursorComposer?.row);
  if (!commandPrefix || !Number.isFinite(promptRow)) {
    return {
      visible: false,
      draftText,
      promptRow: Number.isFinite(promptRow) ? promptRow : null,
      suggestionRows: [],
      reason: commandPrefix ? 'composer-row-missing' : 'composer-not-bare-slash-command',
    };
  }

  const suggestionRows = (Array.isArray(snapshot.lines) ? snapshot.lines : [])
    .filter((line) => {
      const row = Number(line?.row);
      return Number.isFinite(row) && row > promptRow && row <= promptRow + 12;
    })
    .map((line) => {
      const text = normalizeLineText(line?.text);
      const match = text.match(/^\s*\/([a-z][a-z0-9_-]*)(?:\s{2,}|\t)(\S.*)$/i);
      if (!match) return null;
      const command = '/' + match[1].toLowerCase();
      const styled = line?.hasNonDefaultFg === true
        || line?.hasNonDefaultBg === true
        || line?.hasInverse === true;
      if (!styled || !command.startsWith(commandPrefix)) return null;
      return {
        row: Number(line.row),
        command,
        description: String(match[2] || '').trim(),
      };
    })
    .filter(Boolean);

  return {
    visible: suggestionRows.length > 0,
    draftText,
    promptRow,
    suggestionRows,
    reason: suggestionRows.length > 0
      ? 'slash-completion-visible'
      : 'matching-suggestion-not-found',
  };
}

function inspectCodexSlashCompletionDismissal(snapshot, expectedDraftText) {
  const completion = inspectCodexSlashCompletionSnapshot(snapshot);
  const draftText = readCodexComposerDraft(snapshot);
  const expected = String(expectedDraftText || '').trim();
  return {
    completion,
    draftText,
    draftPreserved: !!expected && draftText === expected,
    dismissed: completion.visible !== true,
  };
}

module.exports = {
  inspectCodexSlashCompletionDismissal,
  inspectCodexSlashCompletionSnapshot,
  parseSlashCommandToken,
  readCodexComposerDraft,
};
