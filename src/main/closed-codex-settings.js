'use strict';

// Choosing settings for an archived Codex chat must not start its process.
// Restore only an exact known tab and use the existing background/never-resume
// restore path; the regular main intent remains the sole settings owner.
async function prepareClosedCodexSettings({ tabId, model, effort, findOpen, findArchived, restore }) {
  if (findOpen(tabId)) return { restored: false };
  const completePair = [model, effort].every((value) => typeof value === 'string'
    && value.trim() && value.trim().toLowerCase() !== 'none');
  if (!completePair) return { restored: false };
  const archived = findArchived(tabId);
  if (!archived?.ok || archived.toolType !== 'codex') return { restored: false };
  const result = await restore(tabId, archived);
  return { restored: result.restored === true };
}

module.exports = { prepareClosedCodexSettings };
