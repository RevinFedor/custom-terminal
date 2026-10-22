'use strict';

const CODEX_SETTINGS_CAPABILITY = Object.freeze({ version: 1, standalone: true, busy: true, fast: 'absolute' });

function settingsError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}

function boundedText(value, max) {
  return typeof value === 'string' && !!value.trim() && value.length <= max
    && !/[\u0000-\u001f]/.test(value);
}

function normalizeCodexModelEffort(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['modelSelection', 'effort'].includes(key))
    || input.modelSelection === undefined && input.effort === undefined) {
    throw settingsError('invalid_codex_settings_request');
  }
  const result = {};
  if (input.modelSelection !== undefined) {
    const selected = input.modelSelection;
    if (!selected || typeof selected !== 'object' || Array.isArray(selected)
      || Object.keys(selected).some(key => !['kind', 'id'].includes(key))
      || !['catalog', 'custom'].includes(selected.kind) || !boundedText(selected.id, 512)) {
      throw settingsError('invalid_agent_model_selection');
    }
    result.modelSelection = { kind: selected.kind, id: selected.id.trim() };
  }
  if (input.effort !== undefined) {
    if (!boundedText(input.effort, 64) || input.effort.trim().toLowerCase() === 'none') {
      throw settingsError('invalid_codex_effort');
    }
    result.effort = input.effort.trim().toLowerCase();
  }
  return result;
}

function captureCodexSettingsTarget(tab) {
  if (!tab) throw settingsError('codex_settings_target_not_found', 404);
  if (tab.toolType !== 'codex' || tab.tabType === 'claude-sdk' || tab.tabType === 'file') {
    throw settingsError('codex_settings_provider_mismatch', 409);
  }
  return JSON.stringify([tab.tabId, tab.projectId, tab.cwd, tab.sessionId]);
}

module.exports = { CODEX_SETTINGS_CAPABILITY, settingsError, normalizeCodexModelEffort, captureCodexSettingsTarget };
