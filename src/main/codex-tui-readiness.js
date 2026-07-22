'use strict';

const { composerPromptGlyphs } = require('../shared/codex-tui-grammar.json');

// Composer markers are presentation details owned by Codex, not by the shell.
// Keep the historical single-chevron variants and the v0.145 double chevron.
// ASCII `>` remains a readiness-only fallback; it is intentionally excluded
// from draft extraction because ordinary terminal/history text contains it.
const CODEX_COMPOSER_PROMPT_GLYPHS = Object.freeze([...composerPromptGlyphs]);
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CODEX_COMPOSER_PROMPT_ALTERNATION = CODEX_COMPOSER_PROMPT_GLYPHS
  .map(escapeRegExp)
  .join('|');
const CODEX_COMPOSER_PROMPT_LINE_SOURCE = `(?:^|\\n)([\\t ]*)(${CODEX_COMPOSER_PROMPT_ALTERNATION})(?=\\s|$)`;
const CODEX_COMPOSER_PROMPT_GLYPH_RE = new RegExp(CODEX_COMPOSER_PROMPT_LINE_SOURCE, 'u');
const CODEX_READY_PROMPT_LINE_RE = new RegExp(
  `(?:^|\\n)[\\t ]*(?:${CODEX_COMPOSER_PROMPT_ALTERNATION}|>)(?=\\s|$)`,
  'u',
);
const CODEX_LEADING_COMPOSER_PROMPT_RE = new RegExp(
  `^[\\t ]*(?:${CODEX_COMPOSER_PROMPT_ALTERNATION})(?=\\s|$)\\s*`,
  'u',
);
const CODEX_UI_TEXT_RE = /OpenAI Codex|Use \/skills|Full Access|Find and fix a bug|Explain this codebase|Ask Codex|Context \d+%|directory:\s*|permissions:\s*/i;

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
  return rows.slice(Math.max(0, startIndex)).map((line) => line.text).join('\n');
}

function inspectCodexInputReadyTextCore(clean, raw, {
  blockers = [],
  requireSyncMarker = true,
  source = 'raw',
  syncMarker = '\x1b[?2026l',
} = {}) {
  const text = String(clean || '').replace(/\u00a0/g, ' ');
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return { ready: false, reason: 'empty', source };

  const uniqueBlockers = Array.from(new Set(Array.isArray(blockers) ? blockers : []));
  const hasSynchronizedFrame = String(raw || '').includes(syncMarker);
  if (requireSyncMarker && !hasSynchronizedFrame) {
    return { ready: false, reason: 'no-sync-marker', source, hasSynchronizedFrame };
  }

  const hasCodexUiText = CODEX_UI_TEXT_RE.test(text);
  const hasPromptGlyph = CODEX_READY_PROMPT_LINE_RE.test(text);
  const hasComposerFrame = (/[╭╰│]/u.test(text) || hasPromptGlyph) && hasCodexUiText;

  if (uniqueBlockers.length > 0) {
    return {
      ready: false,
      reason: 'blocked:' + uniqueBlockers.join('+'),
      source,
      blockers: uniqueBlockers,
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
    reason: 'ready',
    source,
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
    return { action: 'cancel', reason: 'mcp-startup-not-current' };
  }
  if (!destructiveProofAvailable) {
    return { action: 'retry', reason: 'destructive-proof-unavailable' };
  }
  return { action: 'restart', reason: 'mcp-startup-current' };
}

function isCodexMcpRestartSignalSafe({
  expectedWatchdog,
  currentWatchdog,
  expectedLaunchId,
  currentLaunchId,
  expectedWriteSeq,
  currentWriteSeq,
  expectedInputRevision,
  currentInputRevision,
  inputReady = false,
  promptOrTurnInFlight = false,
  mirrorAvailable = true,
} = {}) {
  return !!expectedWatchdog
    && currentWatchdog === expectedWatchdog
    && !!expectedLaunchId
    && currentLaunchId === expectedLaunchId
    && Number.isFinite(expectedWriteSeq)
    && currentWriteSeq === expectedWriteSeq
    && Number.isFinite(expectedInputRevision)
    && currentInputRevision === expectedInputRevision
    && mirrorAvailable
    && !inputReady
    && !promptOrTurnInFlight;
}

function shouldLaunchCodexMcpReplacement(stopResult) {
  return stopResult?.success === true;
}

module.exports = {
  CODEX_COMPOSER_PROMPT_GLYPHS,
  decideCodexMcpStartupDeadline,
  findLastCodexComposerPromptIndex,
  hasCodexComposerPromptGlyph,
  inspectCodexInputReadyTextCore,
  isCodexMcpRestartSignalSafe,
  selectCodexCurrentInteractiveFrameText,
  shouldLaunchCodexMcpReplacement,
  stripLeadingCodexComposerPromptGlyph,
};
