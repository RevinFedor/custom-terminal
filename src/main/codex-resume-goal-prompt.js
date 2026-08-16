'use strict';

const RESUME_GOAL_TITLE = 'Resume paused goal?';
const RESUME_GOAL_FOOTER_RE = /^Press enter to confirm or esc to go back$/i;
const RESUME_GOAL_FIRST_SELECTED_RE = /^[\t ]*[›❯»>][\t ]*1\.[\t ]*Resume goal\b/im;
const RESUME_GOAL_SECOND_SELECTED_RE = /^[\t ]*[›❯»>][\t ]*2\.[\t ]*Leave paused\b/im;

function normalizeCodexResumeGoalText(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\u00a0/g, ' ');
}

function inspectCodexResumeGoalPrompt(cleanText) {
  const text = normalizeCodexResumeGoalText(cleanText);
  const titleIndex = text.toLowerCase().lastIndexOf(RESUME_GOAL_TITLE.toLowerCase());
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
  const lines = section
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const lastLine = lines.at(-1) || '';
  const firstOptionSelected = RESUME_GOAL_FIRST_SELECTED_RE.test(section);
  const secondOptionSelected = RESUME_GOAL_SECOND_SELECTED_RE.test(section);
  const checks = {
    title: true,
    goal: /(?:^|\n)[\t ]*Goal:[\t ]*\S/im.test(section),
    resumeOption: /(?:^|\n)[\t ]*(?:[›❯»>][\t ]*)?1\.[\t ]*Resume goal\b/im.test(section),
    resumeDescription: /Mark it active and continue when idle/i.test(compact),
    leaveOption: /(?:^|\n)[\t ]*(?:[›❯»>][\t ]*)?2\.[\t ]*Leave paused\b/im.test(section),
    leaveDescription: /Keep it paused; use \/goal resume later/i.test(compact),
    footer: RESUME_GOAL_FOOTER_RE.test(lastLine),
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
    interactiveVisible,
    canAutoEnter,
    firstOptionSelected,
    secondOptionSelected,
    missing,
    skipReason,
  };
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

module.exports = {
  decideCodexResumeGoalAutoEnter,
  inspectCodexResumeGoalPrompt,
};
