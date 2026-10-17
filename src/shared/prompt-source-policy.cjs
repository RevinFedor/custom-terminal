'use strict';

// One fixed discovery policy for tab/legacy catalogs and their settings UI.
// These are source-root-relative, never an editable per-tab search path.
const PROMPT_SOURCE_FOLDER = 'docs';
const PROMPT_SUFFIX = '.prompt.md';
const PROMPT_SOURCE_POLICY_VERSION = 1;

function includePromptSourceEntry(entry) {
  return !entry.name.startsWith('.') && !entry.isSymbolicLink()
    && !(entry.isDirectory() && entry.name === 'node_modules');
}

module.exports = {PROMPT_SOURCE_FOLDER, PROMPT_SUFFIX, PROMPT_SOURCE_POLICY_VERSION, includePromptSourceEntry};
