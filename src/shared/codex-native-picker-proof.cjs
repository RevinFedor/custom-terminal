'use strict';

// Shared by the renderer's native-picker projection and main's causal owner.
// The text alone is never proof of a user action: callers own that boundary.
const CODEX_EFFORT_VALUES = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const CODEX_PICKER_FOOTER_RE = /Press enter to confirm or esc to go back/i;
const CODEX_PICKER_HEADER_RE = /(?:Select Model and Effort|Select Model(?!\s+and\s+Effort)|Select Reasoning Level|Advanced Reasoning|Apply reasoning change)/i;
const CODEX_CLIPPED_MODEL_PICKER_RE = /\[…\s*\d+\s+lines?\]\s*ctrl\s*\+\s*a\s+view all/i;

function stripCodexTerminalControls(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[(\d*)C/g, (_match, count) => ' '.repeat(Math.min(512, Math.max(1, Number(count) || 1))))
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function isCodexSettingsPickerVisible(visibleText) {
  const clean = stripCodexTerminalControls(visibleText);
  if (!CODEX_PICKER_FOOTER_RE.test(clean)) return false;
  return CODEX_PICKER_HEADER_RE.test(clean) || CODEX_CLIPPED_MODEL_PICKER_RE.test(clean);
}

function parseCodexModelChangeAcknowledgement(output) {
  const clean = stripCodexTerminalControls(output).replace(/\u00a0/g, ' ');
  const pattern = /(?:^|\n)\s*•\s*Model\s+changed\s+to\s+([a-z0-9][a-z0-9_.-]*)(?:\s+(none|minimal|low|medium|high|xhigh|max|ultra))?(\s+for\s+this\s+conversation)?(?=\s|[.!]|$)/gi;
  let latest = null;
  for (const match of clean.matchAll(pattern)) {
    const model = String(match[1] || '').trim();
    const effort = String(match[2] || '').trim().toLowerCase();
    const conversationOnly = !!match[3];
    if (!model || (effort === 'ultra' && !conversationOnly) || (effort && !CODEX_EFFORT_VALUES.has(effort))) continue;
    latest = { model, ...(effort ? { effort } : {}),
      applicationMode: conversationOnly ? 'conversation-only' : 'persistent-default',
      proof: conversationOnly ? 'tui-conversation-ack' : 'tui-model-ack' };
  }
  return latest;
}

module.exports = { stripCodexTerminalControls, isCodexSettingsPickerVisible, parseCodexModelChangeAcknowledgement };
