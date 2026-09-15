'use strict';

const { composerPromptGlyphs } = require('../shared/codex-tui-grammar.json');
const { inspectCodexResumeGoalPrompt } = require('./codex-resume-goal-prompt');
const { inspectCodexUsagePrompt } = require('./codex-usage-prompt');

// Composer markers are presentation details owned by Codex, not by the shell.
// Keep the historical single-chevron variants and the v0.145 double chevron.
// ASCII `>` remains a readiness-only fallback; it is intentionally excluded
// from draft extraction because ordinary terminal/history text contains it.
const CODEX_COMPOSER_PROMPT_GLYPHS = Object.freeze([...composerPromptGlyphs]);
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CODEX_COMPOSER_PROMPT_ALTERNATION = CODEX_COMPOSER_PROMPT_GLYPHS
  .map(escapeRegExp)
  .join('|');
// Codex 0.154 paints braille animation in otherwise empty composer-band cells,
// including the space before/after its prompt marker. Recognize that chrome;
// do NOT strip it from the draft suffix (braille can be real user content).
const CODEX_COMPOSER_PROMPT_LINE_SOURCE = `(?:^|\\n)([\\t \\u2800-\\u28ff]*)(${CODEX_COMPOSER_PROMPT_ALTERNATION})(?=\\s|[\\u2800-\\u28ff]|$)`;
const CODEX_COMPOSER_PROMPT_GLYPH_RE = new RegExp(CODEX_COMPOSER_PROMPT_LINE_SOURCE, 'u');
const CODEX_READY_PROMPT_LINE_RE = new RegExp(
  `(?:^|\\n)[\\t \\u2800-\\u28ff]*(?:${CODEX_COMPOSER_PROMPT_ALTERNATION}|>)(?=\\s|[\\u2800-\\u28ff]|$)`,
  'u',
);
const CODEX_LEADING_COMPOSER_PROMPT_RE = new RegExp(
  `^[\\t ]*(?:${CODEX_COMPOSER_PROMPT_ALTERNATION})(?=\\s|$)\\s*`,
  'u',
);
const CODEX_UI_TEXT_RE = /OpenAI Codex|Use \/skills|Find and fix a bug|Explain this codebase|Ask Codex|directory:\s*|permissions:\s*|Choose\s+how\s+you(?:'|’)?d\s+like\s+Codex\s+to\s+proceed|Try\s+new\s+model|Use\s+existing\s+model|Resume paused goal\?/i;
// Only the stable prefix belongs to the settings contract. Everything after
// the separator is presentation owned by Codex (`Full Access`, Context, cwd,
// Goal achieved, or a future replacement) and must not gate readiness.
const CODEX_COMPOSER_STATUS_PREFIX_RE = /^([a-z0-9][a-z0-9_.-]*)\s+(none|minimal|low|medium|high|xhigh|max|ultra)(?:\s+(fast))?(?:\s*·(?:\s+.*)?|\s+Goal\s+achieved(?:\s+\([^\r\n)]*\))?|)$/i;
const CODEX_MCP_STARTUP_STATUS_ANCHOR_RE = /Starting\s+MCP\s+servers|Booting\s+MCP\s+server|MCP\s+startup\s+interrupted|MCP\s+servers?\s*\(\s*\d+\s*\/\s*\d+\s*\)|servers?\s*\(\s*\d+\s*\/\s*\d+\s*\)/i;
const CODEX_LIVE_INTERRUPT_FOOTER_RE = /esc\s+to\s+interrupt/i;
const CODEX_BOOTSTRAP_STATUS_RE = /^\s*(?:Resuming|Forking)\s+session(?:…|\.{3})\s*$/i;

function hasCodexInitializedComposerFrame(text) {
  if (parseCodexVerifiedComposerFooter(text)) return true;
  // Status-line customization may hide model/effort. The initialized welcome
  // card is another positive signal; StartupDraft always says model: loading.
  const lines = String(text || '').split(/\r?\n/);
  return lines.some((line) => /^\s*[│|]\s*model:\s+(?!loading\b)[a-z0-9][a-z0-9_.-]*(?:\s+.*)?\s+\/model\b.*[│|]\s*$/i.test(line))
    && lines.some((line) => /^\s*[│|]\s*directory:/.test(line));
}

function hasCodexComposerPromptGlyph(text) {
  return CODEX_COMPOSER_PROMPT_GLYPH_RE.test(String(text || ''));
}

function findLastCodexComposerPromptIndex(text) {
  const value = String(text || '');
  let result = -1;
  const matcher = new RegExp(CODEX_COMPOSER_PROMPT_LINE_SOURCE, 'gu');
  for (const match of value.matchAll(matcher)) {
    const glyph = match[2] || '';
    result = match.index + match[0].lastIndexOf(glyph);
  }
  return result;
}

function stripLeadingCodexComposerPromptGlyph(text) {
  return String(text || '').replace(CODEX_LEADING_COMPOSER_PROMPT_RE, '');
}

/**
 * Parse the status row owned by the current Codex composer. Codex normally
 * renders additional access/context/cwd text after the model and effort, but
 * that tail is decorative and changes with viewport width and TUI versions.
 * Callers still own current-frame/generation proof; this helper recognizes only
 * the stable, anchored model + effort (+ optional fast) prefix in that frame.
 */
function parseCodexVerifiedComposerFooter(frameText) {
  const clean = String(frameText || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\u00a0/g, ' ');
  const lines = clean.split(/\r?\n/);
  let footer = '';
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    // Only the decorative prefix, before the anchored model/effort. This is
    // a settings/status row, never a transform of user-message text.
    const candidate = String(lines[index] || '').replace(/^[\t \u2800-\u28ff]+/u, '').trim();
    if (!candidate) continue;
    footer = candidate;
    break;
  }
  if (!footer) return null;
  const match = footer.match(CODEX_COMPOSER_STATUS_PREFIX_RE);
  if (!match) return null;
  const model = String(match[1] || '').trim();
  const effort = String(match[2] || '').trim().toLowerCase();
  if (!model || model.toLowerCase() === 'default' || !effort || effort === 'default') {
    return null;
  }
  return {
    model,
    effort,
    fast: !!match[3],
    proof: 'verified-composer-footer',
  };
}

function selectCodexCurrentInteractiveFrameText(lines, activePromptRow = null) {
  const rows = Array.isArray(lines)
    ? lines.map((line, index) => ({
      row: line?.row !== null && line?.row !== undefined && Number.isFinite(Number(line.row))
        ? Number(line.row)
        : index,
      text: String(line?.text || ''),
    }))
    : String(lines || '').split('\n').map((text, row) => ({ row, text }));
  if (rows.length === 0) return '';

  let startIndex = -1;
  if (activePromptRow !== null && activePromptRow !== undefined && Number.isFinite(Number(activePromptRow))) {
    startIndex = rows.findIndex((line) => line.row === Number(activePromptRow));
  }
  if (startIndex < 0) {
    for (let index = 0; index < rows.length; index++) {
      if (hasCodexComposerPromptGlyph(rows[index].text)) startIndex = index;
    }
  }
  // Codex v0.145 can render a live MCP progress row immediately above the
  // still-visible composer. Starting at the composer alone would erase the
  // blocker and publish a false READY state. Include only the contiguous
  // status band directly above the active prompt; ordinary output between an
  // old startup line and the composer still keeps that scrollback excluded.
  if (startIndex > 0) {
    let candidateStart = startIndex;
    let sawMcpStatus = false;
    let sawLiveInterruptFooter = false;
    for (let index = startIndex - 1; index >= 0 && startIndex - index <= 8; index--) {
      const text = rows[index].text;
      if (!String(text || '').trim()) {
        candidateStart = index;
        continue;
      }
      if (CODEX_LIVE_INTERRUPT_FOOTER_RE.test(text)) {
        candidateStart = index;
        sawLiveInterruptFooter = true;
        continue;
      }
      if (CODEX_MCP_STARTUP_STATUS_ANCHOR_RE.test(text)) {
        candidateStart = index;
        sawMcpStatus = true;
        break;
      }
      if (CODEX_BOOTSTRAP_STATUS_RE.test(text)) {
        candidateStart = index;
        sawMcpStatus = true;
        break;
      }
      // On a narrow terminal the server-name list wraps into otherwise generic
      // rows. Only the nearby live `esc to interrupt` footer authorizes walking
      // through those rows in search of the MCP anchor; without it, ordinary
      // historical output remains a hard boundary.
      if (sawLiveInterruptFooter) {
        candidateStart = index;
        continue;
      }
      break;
    }
    if (sawMcpStatus) startIndex = candidateStart;
  }
  // Keep only a contiguous bordered welcome card adjacent to this composer.
  // A header somewhere in old transcript output cannot initialize a new input.
  if (startIndex > 0) {
    let cardStart = startIndex;
    let sawCard = false;
    for (let index = startIndex - 1; index >= 0 && startIndex - index <= 16; index--) {
      const text = rows[index].text.trim();
      if (!text || CODEX_BOOTSTRAP_STATUS_RE.test(text)) {
        cardStart = index;
        continue;
      }
      if (/^[╭╰│|]/u.test(text)) {
        cardStart = index;
        sawCard = true;
        if (/^╭/u.test(text)) break;
        continue;
      }
      break;
    }
    if (sawCard && rows.slice(cardStart, startIndex).some((line) => /[│|]\s*model:/.test(line.text))) {
      startIndex = cardStart;
    }
  }
  // The selected "› 1. Resume goal" row is a menu selection, not a composer.
  // Keep its current modal header; otherwise readiness calls it generic
  // initialization and loses the actual blocker. A later composer/footer
  // invalidates this scope, so old dialogs in history remain excluded.
  const full = rows.map(line => line.text).join('\n');
  const usage = inspectCodexUsagePrompt(full);
  if (usage.visible) return full.slice(usage.startIndex);
  const goal = inspectCodexResumeGoalPrompt(full);
  if (goal.visible && !goal.missing.includes('footer')
    && (goal.firstOptionSelected || goal.secondOptionSelected)) return full.slice(goal.titleIndex);
  return rows.slice(Math.max(0, startIndex)).map((line) => line.text).join('\n');
}

function classifyCodexMcpStartupBlockerHandling({
  authoritativeCurrentFrame = false,
  promptOrTurnInFlight = false,
  alreadyReady = false,
  startupLifecycleFresh = false,
} = {}) {
  if (authoritativeCurrentFrame) {
    return { ignore: false, reason: 'authoritative-current-frame' };
  }
  if (promptOrTurnInFlight) {
    return { ignore: true, reason: 'prompt-or-turn-in-flight' };
  }
  if (alreadyReady) {
    return { ignore: true, reason: 'already-ready' };
  }
  if (!startupLifecycleFresh) {
    return { ignore: true, reason: 'not-startup-lifecycle' };
  }
  return { ignore: false, reason: 'startup-lifecycle' };
}

function decideCodexLateMcpCommittedFrame({
  identityCurrent = false,
  candidateWriteSeq = null,
  committedWriteSeq = null,
  authoritativeFrameCommitted = false,
  inspected = null,
} = {}) {
  if (!identityCurrent) return { action: 'cancel', reason: 'lifecycle-changed' };
  const candidateSeq = Number(candidateWriteSeq);
  const committedSeq = Number(committedWriteSeq);
  if (!Number.isInteger(candidateSeq)
    || candidateSeq <= 0
    || !Number.isInteger(committedSeq)
    || committedSeq <= 0
    || committedSeq < candidateSeq
    || authoritativeFrameCommitted !== true) {
    return { action: 'wait', reason: 'candidate-frame-not-committed' };
  }
  const blockers = Array.isArray(inspected?.blockers) ? inspected.blockers : [];
  if (blockers.length > 0) {
    return { action: 'block', reason: 'current-blocker:' + blockers.join('+') };
  }
  if (inspected?.ready === true) {
    return { action: 'clear', reason: 'current-composer-ready' };
  }
  // This proof owns only the late MCP diagnosis. Once the exact candidate
  // write is committed, a current frame with no MCP blocker must release it
  // even when an app-owned slash command has made the composer transitional.
  // Other control surfaces keep their own guards; the stale warning above the
  // current composer cannot turn this diagnostic into a modal input lock.
  if (inspected && blockers.length === 0) {
    return { action: 'clear', reason: 'current-mcp-blocker-absent' };
  }
  return { action: 'wait', reason: 'current-frame-transitional' };
}

function validateCodexLateMcpRecoveryIdentity({
  expectedTerminal = null,
  currentTerminal = null,
  expectedTerminalGeneration = null,
  currentTerminalGeneration = null,
  expectedRunSeq = null,
  currentRunSeq = null,
  expectedInputRevision = null,
  currentInputRevision = null,
  expectedLaunchId = null,
  currentLaunchId = null,
  currentProcessRunning = true,
  currentStopping = false,
} = {}) {
  if (currentStopping === true) {
    return { valid: false, reason: 'terminal-stopping' };
  }
  if (currentProcessRunning !== true) {
    return { valid: false, reason: 'terminal-process-stopped' };
  }
  if (!expectedTerminal || currentTerminal !== expectedTerminal) {
    return { valid: false, reason: 'terminal-instance-changed' };
  }
  if (!expectedTerminalGeneration
    || currentTerminalGeneration !== expectedTerminalGeneration) {
    return { valid: false, reason: 'terminal-generation-changed' };
  }
  if (!Number.isInteger(Number(expectedRunSeq))
    || Number(expectedRunSeq) <= 0
    || Number(currentRunSeq) !== Number(expectedRunSeq)) {
    return { valid: false, reason: 'terminal-run-changed' };
  }
  if (!Number.isInteger(Number(expectedInputRevision))
    || Number(currentInputRevision) !== Number(expectedInputRevision)) {
    return { valid: false, reason: 'terminal-input-changed' };
  }
  if (!expectedLaunchId || currentLaunchId !== expectedLaunchId) {
    return { valid: false, reason: 'launch-generation-changed' };
  }
  return { valid: true, reason: 'exact-late-mcp-recovery-generation' };
}

function inspectCodexInputReadyTextCore(clean, raw, {
  blockers = [],
  requireSyncMarker = true,
  source = 'raw',
  syncMarker = '\x1b[?2026l',
  requireInitializedComposer = false,
} = {}) {
  const text = String(clean || '').replace(/\u00a0/g, ' ');
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return { ready: false, reason: 'empty', source };

  const uniqueBlockers = Array.from(new Set(Array.isArray(blockers) ? blockers : []));
  const hasSynchronizedFrame = String(raw || '').includes(syncMarker);
  if (requireSyncMarker && !hasSynchronizedFrame) {
    return { ready: false, reason: 'no-sync-marker', source, hasSynchronizedFrame };
  }

  const composerFooter = parseCodexVerifiedComposerFooter(text);
  const hasCodexUiText = CODEX_UI_TEXT_RE.test(text) || !!composerFooter;
  const hasPromptGlyph = CODEX_READY_PROMPT_LINE_RE.test(text);
  const hasComposerFrame = (/[╭╰│]/u.test(text) || hasPromptGlyph) && hasCodexUiText;
  // Codex keeps the composer interactive while background MCP clients are
  // starting. The progress row is therefore not an input blocker once this
  // exact frame also proves the composer and its model/effort footer. Keep the
  // interrupted/failure form blocked: it is a different terminal state and
  // must not be inferred from the ordinary in-progress banner.
  const mcpStartupInProgress = /Starting\s+MCP\s+servers|Booting\s+MCP\s+server|MCP\s+servers?\s*\(\s*\d+\s*\/\s*\d+\s*\)|servers?\s*\(\s*\d+\s*\/\s*\d+\s*\)/i.test(text)
    && !/MCP\s+startup\s+interrupted|MCP\s+startup\s+incomplete/i.test(text);
  const composerAcceptsInputDuringMcpStartup = uniqueBlockers.includes('mcp-startup')
    && mcpStartupInProgress
    && !!composerFooter
    && hasPromptGlyph
    && hasComposerFrame;
  const effectiveBlockers = composerAcceptsInputDuringMcpStartup
    ? uniqueBlockers.filter((blocker) => blocker !== 'mcp-startup')
    : uniqueBlockers;

  if (effectiveBlockers.length > 0) {
    return {
      ready: false,
      reason: 'blocked:' + effectiveBlockers.join('+'),
      source,
      blockers: effectiveBlockers,
      hasSynchronizedFrame,
      hasCodexUiText,
      hasPromptGlyph,
      hasComposerFrame,
    };
  }
  if (requireInitializedComposer && !hasCodexInitializedComposerFrame(text)) {
    return {
      ready: false,
      reason: 'composer-initialization-pending',
      source,
      blockers: [],
      hasSynchronizedFrame,
      hasCodexUiText,
      hasPromptGlyph,
      hasComposerFrame,
    };
  }
  if (!hasCodexUiText) {
    return { ready: false, reason: 'no-codex-ui-text', source, hasSynchronizedFrame, hasPromptGlyph };
  }
  if (!hasComposerFrame) {
    return { ready: false, reason: 'no-composer-frame', source, hasSynchronizedFrame, hasCodexUiText, hasPromptGlyph };
  }
  return {
    ready: true,
    reason: composerAcceptsInputDuringMcpStartup
      ? 'ready:mcp-startup-background'
      : 'ready',
    source,
    blockers: [],
    ignoredBlockers: composerAcceptsInputDuringMcpStartup ? ['mcp-startup'] : [],
    hasSynchronizedFrame,
    hasCodexUiText,
    hasPromptGlyph,
    hasComposerFrame,
  };
}

function decideCodexMcpStartupDeadline({
  observationAvailable,
  destructiveProofAvailable = false,
  inspected,
  mcpVisible = false,
} = {}) {
  if (!observationAvailable || !inspected) {
    return { action: 'retry', reason: 'current-state-unavailable' };
  }
  if (inspected.ready) {
    return { action: 'mark-ready', reason: 'current-composer-ready' };
  }
  const blockers = Array.isArray(inspected.blockers) ? inspected.blockers : [];
  if (!mcpVisible && !blockers.includes('mcp-startup')) {
    return blockers.length > 0
      ? { action: 'cancel', reason: 'different-current-blocker' }
      : { action: 'retry', reason: 'current-frame-transitional' };
  }
  if (!destructiveProofAvailable) {
    return { action: 'retry', reason: 'destructive-proof-unavailable' };
  }
  return { action: 'restart', reason: 'mcp-startup-current' };
}

function decideCodexMcpWatchdogReconcile({
  inspected,
  mcpVisible = false,
  synchronizedOutputOpen = false,
  authoritativeFrameCommitted = true,
} = {}) {
  if (!inspected) return { action: 'keep', reason: 'current-state-unavailable' };
  if (synchronizedOutputOpen || !authoritativeFrameCommitted) {
    return { action: 'keep', reason: 'current-frame-transitional' };
  }
  // A verified composer is usable even if its adjacent status band still says
  // that MCP clients are starting. Never preserve a destructive restart timer
  // over stronger current-frame input proof.
  if (inspected.ready) {
    return { action: 'clear', reason: 'current-composer-ready' };
  }
  const blockers = Array.isArray(inspected.blockers) ? inspected.blockers : [];
  if (mcpVisible || blockers.includes('mcp-startup')) {
    return { action: 'keep', reason: 'mcp-startup-current' };
  }
  if (blockers.length > 0) {
    return { action: 'clear', reason: 'different-current-blocker' };
  }
  // Codex redraws the animated MCP row through synchronized-output frames.
  // A headless snapshot can observe a short frame where that row is erased but
  // the replacement glyphs have not landed yet. Absence in an otherwise
  // unclassified frame is therefore not proof that the blocker ended.
  return { action: 'keep', reason: 'current-frame-transitional' };
}

function isCodexMcpRestartSignalSafe({
  expectedWatchdog,
  currentWatchdog,
  expectedTerminal,
  currentTerminal,
  expectedTerminalGeneration,
  currentTerminalGeneration,
  expectedRunSeq,
  currentRunSeq,
  expectedLaunchId,
  currentLaunchId,
  expectedMirrorGeneration,
  currentMirrorGeneration,
  expectedWriteSeq,
  currentWriteSeq,
  expectedCommittedFrameGeneration,
  currentCommittedFrameGeneration,
  expectedInputRevision,
  currentInputRevision,
  inputReady = false,
  promptOrTurnInFlight = false,
  mirrorAvailable = true,
  mcpStartupBlockerCurrent = false,
} = {}) {
  return !!expectedWatchdog
    && currentWatchdog === expectedWatchdog
    && !!expectedTerminal
    && currentTerminal === expectedTerminal
    && !!expectedTerminalGeneration
    && currentTerminalGeneration === expectedTerminalGeneration
    && Number.isInteger(Number(expectedRunSeq))
    && Number(currentRunSeq) === Number(expectedRunSeq)
    && !!expectedLaunchId
    && currentLaunchId === expectedLaunchId
    && !!expectedMirrorGeneration
    && currentMirrorGeneration === expectedMirrorGeneration
    && Number.isFinite(expectedWriteSeq)
    && Number(currentWriteSeq) >= Number(expectedWriteSeq)
    && Number.isInteger(Number(expectedCommittedFrameGeneration))
    && Number(currentCommittedFrameGeneration) >= Number(expectedCommittedFrameGeneration)
    && Number.isFinite(expectedInputRevision)
    && currentInputRevision === expectedInputRevision
    && mirrorAvailable
    && mcpStartupBlockerCurrent
    && !inputReady
    && !promptOrTurnInFlight;
}

function shouldLaunchCodexMcpReplacement(stopResult) {
  return stopResult?.success === true;
}

const CODEX_MCP_REPLACEMENT_HANDOFF_PHASES = new Set([
  'stopping',
  'stopped',
  'claiming',
  'claimed',
]);

function shouldSuppressCodexMcpWatchdogArmForReplacementHandoff({
  handoffOwned = false,
  handoffPhase = null,
} = {}) {
  return handoffOwned === true
    && CODEX_MCP_REPLACEMENT_HANDOFF_PHASES.has(handoffPhase);
}

function decideCodexMcpReplacementHandoff({
  stopSucceeded = false,
  sameTerminal = false,
  expectedTerminalGeneration = null,
  currentTerminalGeneration = null,
  expectedRunSeq = null,
  currentRunSeq = null,
  expectedInputRevision = null,
  currentInputRevision = null,
  expectedLaunchId = null,
  currentLaunchId = null,
  processStatus = 'unknown',
  watchdogSuperseded = false,
} = {}) {
  if (!stopSucceeded) return { allowed: false, reason: 'stop-not-confirmed' };
  if (!sameTerminal) return { allowed: false, reason: 'terminal-instance-changed' };
  if (!expectedTerminalGeneration
    || expectedTerminalGeneration !== currentTerminalGeneration) {
    return { allowed: false, reason: 'terminal-generation-changed' };
  }
  if (!Number.isInteger(Number(expectedRunSeq))
    || Number(expectedRunSeq) !== Number(currentRunSeq)) {
    return { allowed: false, reason: 'terminal-run-changed' };
  }
  if (!Number.isInteger(Number(expectedInputRevision))
    || Number(expectedInputRevision) !== Number(currentInputRevision)) {
    return { allowed: false, reason: 'terminal-input-changed' };
  }
  if (!expectedLaunchId || expectedLaunchId !== currentLaunchId) {
    return { allowed: false, reason: 'launch-generation-changed' };
  }
  if (watchdogSuperseded) {
    return { allowed: false, reason: 'watchdog-generation-changed' };
  }
  if (processStatus !== 'absent') {
    return {
      allowed: false,
      reason: processStatus === 'found'
        ? 'replacement-process-already-present'
        : 'replacement-process-state-unknown',
    };
  }
  return { allowed: true, reason: 'exact-stopped-launch-handoff' };
}

function decideClaimedCodexMcpReplacementHandoff({
  sameTerminal = false,
  expectedTerminalGeneration = null,
  currentTerminalGeneration = null,
  previousRunSeq = null,
  expectedRunSeq = null,
  currentRunSeq = null,
  expectedInputRevision = null,
  currentInputRevision = null,
  expectedLaunchId = null,
  currentLaunchId = null,
  processStatus = 'unknown',
  replacementInputBarrierOwned = false,
} = {}) {
  if (!sameTerminal) return { allowed: false, reason: 'terminal-instance-changed' };
  if (!expectedTerminalGeneration
    || expectedTerminalGeneration !== currentTerminalGeneration) {
    return { allowed: false, reason: 'terminal-generation-changed' };
  }
  if (!Number.isInteger(Number(previousRunSeq))
    || !Number.isInteger(Number(expectedRunSeq))
    || Number(expectedRunSeq) !== Number(previousRunSeq) + 1) {
    return { allowed: false, reason: 'replacement-run-transition-invalid' };
  }
  if (Number(expectedRunSeq) !== Number(currentRunSeq)) {
    return { allowed: false, reason: 'terminal-run-changed' };
  }
  if (!Number.isInteger(Number(expectedInputRevision))
    || Number(expectedInputRevision) !== Number(currentInputRevision)) {
    return { allowed: false, reason: 'terminal-input-changed' };
  }
  if (!expectedLaunchId || expectedLaunchId !== currentLaunchId) {
    return { allowed: false, reason: 'launch-generation-changed' };
  }
  if (processStatus !== 'absent') {
    return {
      allowed: false,
      reason: processStatus === 'found'
        ? 'replacement-process-already-present'
        : 'replacement-process-state-unknown',
    };
  }
  if (!replacementInputBarrierOwned) {
    return { allowed: false, reason: 'replacement-input-barrier-changed' };
  }
  return { allowed: true, reason: 'exact-claimed-replacement-handoff' };
}

function decideCodexMcpStoppedGenerationSettlement({
  stopAbsenceProven = false,
  sameTerminal = false,
  expectedTerminalGeneration = null,
  currentTerminalGeneration = null,
  expectedRunSeq = null,
  currentRunSeq = null,
  expectedInputRevision = null,
  currentInputRevision = null,
  expectedLaunchId = null,
  currentLaunchId = null,
  replacementInputBarrierOwned = false,
  processStatus = 'unknown',
} = {}) {
  if (!stopAbsenceProven) return { allowed: false, reason: 'stop-absence-not-proven' };
  if (!sameTerminal) return { allowed: false, reason: 'terminal-instance-changed' };
  if (!expectedTerminalGeneration
    || expectedTerminalGeneration !== currentTerminalGeneration) {
    return { allowed: false, reason: 'terminal-generation-changed' };
  }
  if (!Number.isInteger(Number(expectedRunSeq))
    || Number(expectedRunSeq) !== Number(currentRunSeq)) {
    return { allowed: false, reason: 'terminal-run-changed' };
  }
  if (!Number.isInteger(Number(expectedInputRevision))
    || Number(expectedInputRevision) !== Number(currentInputRevision)) {
    return { allowed: false, reason: 'terminal-input-changed' };
  }
  if (!expectedLaunchId || expectedLaunchId !== currentLaunchId) {
    return { allowed: false, reason: 'launch-generation-changed' };
  }
  if (!replacementInputBarrierOwned) {
    return { allowed: false, reason: 'replacement-input-barrier-changed' };
  }
  if (processStatus === 'found') {
    return { allowed: false, reason: 'replacement-process-already-present' };
  }
  return {
    allowed: true,
    reason: processStatus === 'absent'
      ? 'exact-stopped-generation-settlement'
      : 'exact-stopped-generation-settlement-from-stop-proof',
  };
}

module.exports = {
  CODEX_COMPOSER_PROMPT_GLYPHS,
  classifyCodexMcpStartupBlockerHandling,
  decideCodexLateMcpCommittedFrame,
  decideClaimedCodexMcpReplacementHandoff,
  decideCodexMcpReplacementHandoff,
  decideCodexMcpStoppedGenerationSettlement,
  decideCodexMcpStartupDeadline,
  decideCodexMcpWatchdogReconcile,
  findLastCodexComposerPromptIndex,
  hasCodexComposerPromptGlyph,
  inspectCodexInputReadyTextCore,
  isCodexMcpRestartSignalSafe,
  parseCodexVerifiedComposerFooter,
  selectCodexCurrentInteractiveFrameText,
  shouldLaunchCodexMcpReplacement,
  shouldSuppressCodexMcpWatchdogArmForReplacementHandoff,
  stripLeadingCodexComposerPromptGlyph,
  validateCodexLateMcpRecoveryIdentity,
};
