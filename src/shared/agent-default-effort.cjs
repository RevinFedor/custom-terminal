'use strict';

// Global launch preferences, not observed native settings. An unset preference
// now means LOW; it must never become a synthetic proof about a running CLI.
function normalizeAgentDefaultEffort(value, provider) {
  const effort = typeof value === 'string' ? value.trim() : '';
  if (!effort || /^(?:none|default|auto)$/i.test(effort)
      || (provider === 'codex' && effort === 'ultra')) return 'low';
  return effort;
}

module.exports = { normalizeAgentDefaultEffort };
