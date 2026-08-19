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
    && /1\.\s*Yes, I trust this folder/i.test(text)
    && /2\.\s*No, exit/i.test(text);
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
  let selectedOption = null;
  for (const line of lines) {
    const normalized = normalizeClaudeTrustFolderText(line);
    if (/^(?:❯|›|>)\s*1\.\s*Yes, I trust this folder$/i.test(normalized)) {
      selectedOption = 1;
      break;
    }
    if (/^(?:❯|›|>)\s*2\.\s*No, exit$/i.test(normalized)) {
      selectedOption = 2;
      break;
    }
  }
  return {
    visible: true,
    selectedOption,
    reason: selectedOption === null ? 'selection-unproven' : 'trust-prompt-visible',
  };
}

module.exports = {
  inspectClaudeTrustFolderPromptSnapshot,
  looksLikeClaudeTrustFolderPromptHintText,
  looksLikeClaudeTrustFolderPromptText,
  normalizeClaudeTrustFolderText,
};
