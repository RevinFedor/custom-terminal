'use strict';

function normalizeCodexUpdatePromptText(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\u00a0/g, ' ');
}

function inspectCodexUpdatePrompt(cleanText) {
  const normalized = normalizeCodexUpdatePromptText(cleanText);
  const lower = normalized.toLowerCase();
  const titleIndex = lower.lastIndexOf('update available');
  if (titleIndex < 0) {
    return {
      visible: false,
      canAutoSkip: false,
      interactiveVisible: false,
      passiveVisible: false,
      firstOptionSelected: false,
      secondOptionSelected: false,
      thirdOptionSelected: false,
      missing: ['title'],
      skipReason: 'not-visible',
    };
  }

  // Scope every decision to the latest update title. An old modal can remain
  // in scrollback and must not authorize keys against a newer composer.
  const text = normalized.slice(titleIndex);
  const compact = text.toLowerCase().replace(/\s+/g, ' ');
  const squashed = compact.replace(/[^a-z0-9]+/g, '');
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const lastLine = lines.at(-1) || '';
  const hasPhrase = (phrase) => squashed.includes(
    String(phrase).toLowerCase().replace(/[^a-z0-9]+/g, ''),
  );
  const firstOptionSelected = /[›❯>][\t ]*1\.[\t ]*Update\s+now/i.test(text);
  const secondOptionSelected = /[›❯>][\t ]*2\.[\t ]*Skip(?!\s+until)/i.test(text);
  const thirdOptionSelected = /[›❯>][\t ]*3\.[\t ]*Skip\s+until\s+next\s+version/i.test(text);
  const checks = {
    title: true,
    updateNow: hasPhrase('update now'),
    skip: hasPhrase('skip'),
    skipUntilNext: hasPhrase('skip until next version'),
    continueHint: /^press enter to continue$/i.test(lastLine),
    installHint: hasPhrase('run npm install g openai codex to update'),
    releaseNotes: hasPhrase('github com openai codex releases latest')
      || hasPhrase('see full release notes'),
  };
  const missing = Object.entries(checks)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  const interactiveVisible = checks.updateNow && checks.skip && checks.skipUntilNext;
  const passiveVisible = checks.installHint || checks.releaseNotes;
  const visible = interactiveVisible || passiveVisible;
  const canAutoSkip = interactiveVisible
    && checks.continueHint
    && (firstOptionSelected || secondOptionSelected)
    && !thirdOptionSelected;
  let skipReason = null;
  if (passiveVisible && !interactiveVisible) skipReason = 'passive-update-banner';
  else if (visible && missing.length > 0) skipReason = 'missing:' + missing.join(',');
  else if (visible && thirdOptionSelected) skipReason = 'skip-until-next-selected';
  else if (visible && !firstOptionSelected && !secondOptionSelected) {
    skipReason = 'skip-option-not-reachable';
  }
  return {
    visible,
    canAutoSkip,
    interactiveVisible,
    passiveVisible,
    firstOptionSelected,
    secondOptionSelected,
    thirdOptionSelected,
    missing,
    skipReason,
  };
}

function validateCodexUpdatePromptBoundary({
  sameTerminal,
  sameRunSeq,
  sameInputRevision,
  screenAvailable,
} = {}) {
  if (sameTerminal !== true) return 'terminal-changed';
  if (sameRunSeq !== true) return 'run-changed';
  if (sameInputRevision !== true) return 'input-changed';
  if (screenAvailable !== true) return 'screen-unavailable';
  return null;
}

function decideCodexUpdatePromptAction(options = {}) {
  const boundaryError = validateCodexUpdatePromptBoundary(options);
  if (boundaryError) return { allowed: false, reason: boundaryError };
  const prompt = inspectCodexUpdatePrompt(options.cleanText);
  if (!prompt.interactiveVisible) {
    return {
      allowed: false,
      reason: prompt.visible ? (prompt.skipReason || 'prompt-not-interactive') : 'prompt-closed',
      prompt,
    };
  }
  if (!prompt.canAutoSkip) {
    return {
      allowed: false,
      reason: prompt.skipReason || 'skip-not-proven',
      prompt,
    };
  }
  return {
    allowed: true,
    reason: prompt.secondOptionSelected ? 'skip-selected' : 'update-selected',
    action: prompt.secondOptionSelected ? 'confirm-skip' : 'select-skip',
    prompt,
  };
}

function decideCodexUpdatePromptDismissal(options = {}) {
  const boundaryError = validateCodexUpdatePromptBoundary(options);
  if (boundaryError) return { allowed: false, reason: boundaryError };
  const prompt = inspectCodexUpdatePrompt(options.cleanText);
  if (prompt.interactiveVisible) {
    return { allowed: false, reason: 'prompt-still-visible', prompt };
  }
  return { allowed: true, reason: 'prompt-dismissed', prompt };
}

module.exports = {
  decideCodexUpdatePromptAction,
  decideCodexUpdatePromptDismissal,
  inspectCodexUpdatePrompt,
};
