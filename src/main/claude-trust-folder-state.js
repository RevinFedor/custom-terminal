'use strict';

function normalizeClaudeTrustFolderText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeClaudeTrustFolderPromptText(value) {
  const text = normalizeClaudeTrustFolderText(value);
  if (!text) return false;
  return /Quick safety check:\s*Is this a project you created or one you trust\?/i.test(text)
    && /Claude Code(?:'|’)?ll be able to read, edit, and execute files here\./i.test(text)
    && /Security guide/i.test(text)
    && /Yes, I trust this folder/i.test(text)
    && /No, exit/i.test(text);
}

function looksLikeClaudeTrustFolderPromptHintText(value) {
  const text = normalizeClaudeTrustFolderText(value);
  return /Quick safety check:\s*Is this a project you created or one you trust\?/i.test(text);
}

function inspectClaudeTrustFolderPromptSnapshot(snapshot) {
  if (snapshot?.success !== true || !Array.isArray(snapshot.lines)) {
    return { visible: false, selectedOption: null, reason: 'snapshot-unavailable' };
  }
  const lines = snapshot.lines.map((line) => String(line?.text || ''));
  const text = lines.join('\n');
  if (!looksLikeClaudeTrustFolderPromptText(text)) {
    return { visible: false, selectedOption: null, reason: 'trust-prompt-not-visible' };
  }
  const selectedOptions = [];
  for (const line of lines) {
    const normalized = normalizeClaudeTrustFolderText(line);
    // New CLI builds omit numbers and may put No first. Return the semantic
    // option expected by the owner, independent of displayed row numbers.
    if (/^(?:❯|›|>)\s*(?:\d+\.\s*)?Yes, I trust this folder$/i.test(normalized)) {
      selectedOptions.push(1);
    }
    if (/^(?:❯|›|>)\s*(?:\d+\.\s*)?No, exit$/i.test(normalized)) {
      selectedOptions.push(2);
    }
  }
  const selectedOption = selectedOptions.length === 1 ? selectedOptions[0] : null;
  return {
    visible: true,
    selectedOption,
    reason: selectedOption === null ? 'selection-unproven' : 'trust-prompt-visible',
  };
}

// The managed-launch policy chooses semantic Yes. Only a complete, selected
// two-option menu can tell the writer which direction reaches it.
function getClaudeTrustFolderSelectionKey(snapshot) {
  const inspection = inspectClaudeTrustFolderPromptSnapshot(snapshot);
  if (!inspection.visible || inspection.selectedOption !== 2) return null;
  const rows = snapshot.lines.map((line) => normalizeClaudeTrustFolderText(line?.text));
  const yesRows = rows.flatMap((line, index) => (
    /^(?:(?:❯|›|>)\s*)?(?:\d+\.\s*)?Yes, I trust this folder$/i.test(line) ? [index] : []
  ));
  const noRows = rows.flatMap((line, index) => (
    /^(?:(?:❯|›|>)\s*)?(?:\d+\.\s*)?No, exit$/i.test(line) ? [index] : []
  ));
  if (yesRows.length !== 1 || noRows.length !== 1) return null;
  return yesRows[0] < noRows[0] ? '\x1b[A' : '\x1b[B';
}

module.exports = {
  getClaudeTrustFolderSelectionKey,
  inspectClaudeTrustFolderPromptSnapshot,
  looksLikeClaudeTrustFolderPromptHintText,
  looksLikeClaudeTrustFolderPromptText,
  normalizeClaudeTrustFolderText,
};
