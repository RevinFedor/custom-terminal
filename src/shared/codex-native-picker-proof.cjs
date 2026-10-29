'use strict';

// Shared by the renderer's native-picker projection and main's causal owner.
// The text alone is never proof of a user action: callers own that boundary.
const CODEX_EFFORT_VALUES = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
// Newer Codex renders the same two actions as compact footer labels. This
// detects only the surface; the caller must still own the input/turn boundary.
const CODEX_PICKER_FOOTER_RE = /(?:Press enter to confirm or esc to go back|(?:^|\n)[\t ]*enter[\t ]+select[\t ]*[·•][\t ]*esc[\t ]+back[\t ]*(?=\r?\n|$))/i;
const CODEX_PICKER_HEADER_RE = /(?:Select Model and Effort|Select Model(?!\s+and\s+Effort)|Select Reasoning Level|Advanced Reasoning|Apply reasoning change)/i;
const CODEX_CLIPPED_MODEL_PICKER_RE = /\[…\s*\d+\s+lines?\]\s*ctrl\s*\+\s*a\s+view all/i;

// Known provider labels verified against their runtime IDs. This is only the
// offline fallback; a current catalog with conflicting labels is ambiguous.
const CODEX_KNOWN_DISPLAY_LABELS = Object.freeze({
  'luna reserve': 'gpt-reserve',
  'gpt-6.1 terra': 'gpt-6.1-terra',
});
const normalizeModelLabel = value => String(value || '').trim().replace(/[\t ]+/g, ' ').toLowerCase();
const CODEX_RUNTIME_MODEL_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;

function resolveCodexDisplayModelIdentity(value, catalog = []) {
  const label = normalizeModelLabel(value);
  if (!label) return null;
  const matches = (Array.isArray(catalog) ? catalog : []).filter(row =>
    normalizeModelLabel(row?.label) === label || normalizeModelLabel(row?.id) === label);
  if (matches.some(row => !CODEX_RUNTIME_MODEL_ID_RE.test(String(row?.id || '').trim()))) return null;
  const ids = [...new Set(matches.map(row => normalizeModelLabel(row.id)))];
  if (ids.length > 1) return null;
  if (ids.length === 1) return ids[0];
  return CODEX_KNOWN_DISPLAY_LABELS[label] || (CODEX_RUNTIME_MODEL_ID_RE.test(label) ? label : null);
}

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

function parseCodexModelChangeAcknowledgement(output, catalog = []) {
  const clean = stripCodexTerminalControls(output).replace(/\u00a0/g, ' ');
  const pattern = /(?:^|\n)\s*•\s*Model\s+changed\s+to\s+([a-z0-9][a-z0-9_.-]*)(?:\s+(none|minimal|low|medium|high|xhigh|max|ultra))?(\s+for\s+this\s+conversation)?(?=\s|[.!]|$)/gi;
  const markers = [...clean.matchAll(/(?:^|\n)[\t ]*•[\t ]*Model[\t ]+changed[\t ]+to[\t ]+/gi)];
  const lastMarker = markers.at(-1);
  const lastBullet = lastMarker ? lastMarker.index + lastMarker[0].lastIndexOf('•') : -1;
  let latest = null;
  for (const match of clean.matchAll(pattern)) {
    // A later malformed or unresolved ACK cannot resurrect an older model.
    if (clean.indexOf('•', match.index) !== lastBullet) continue;
    let model = String(match[1] || '').trim();
    let effort = String(match[2] || '').trim().toLowerCase();
    let conversationOnly = !!match[3];
    // A display name can contain spaces. The legacy first-token match must
    // not turn "GPT-7.2 Artemis" into a successful ACK for "GPT-7.2".
    // Preserve legacy single-ID acknowledgement and its existing suffixes.
    const rest = clean.slice((match.index || 0) + match[0].length).split(/\r?\n/, 1)[0];
    if (!effort && !conversationOnly && /^[\t ]+[a-z0-9]/i.test(rest)) {
      const full = (model + rest).trim().match(/^(.+?)(?:[\t ]+(none|minimal|low|medium|high|xhigh|max|ultra))?(\s+for\s+this\s+conversation)?[.!]?[\t ]*$/i);
      if (!full) { latest = null; continue; }
      model = full[1].trim(); effort = String(full[2] || '').toLowerCase(); conversationOnly = !!full[3];
    }
    model = resolveCodexDisplayModelIdentity(model, catalog);
    if (!model || (effort === 'ultra' && !conversationOnly) || (effort && !CODEX_EFFORT_VALUES.has(effort))) {
      latest = null; continue;
    }
    latest = { model, ...(effort ? { effort } : {}),
      applicationMode: conversationOnly ? 'conversation-only' : 'persistent-default',
      proof: conversationOnly ? 'tui-conversation-ack' : 'tui-model-ack' };
  }
  return latest;
}

module.exports = { CODEX_PICKER_FOOTER_RE, stripCodexTerminalControls, isCodexSettingsPickerVisible,
  resolveCodexDisplayModelIdentity, parseCodexModelChangeAcknowledgement };
