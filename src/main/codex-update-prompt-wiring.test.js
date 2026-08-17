'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');

test('startup update modal is selected and confirmed as two acknowledged writes', () => {
  const helper = main.slice(
    main.indexOf('async function performCodexStartupUpdateAutoSkip'),
    main.indexOf('function isCodexTrustDirectoryPrompt'),
  );
  assert.match(helper, /readCodexAuthoritativeScreen\(tabId, 'startup-update-action'\)/);
  assert.match(helper, /decideCodexUpdatePromptAction\(/);
  assert.match(helper, /sendCodexKeyAndCapture\([\s\S]*?'\\x1b\[B'/);
  assert.match(helper, /writePhase: 'update-select-skip'/);
  assert.match(helper, /admission\.action !== 'confirm-skip'/);
  assert.match(helper, /sendCodexKeyAndCapture\([\s\S]*?'\\r'/);
  assert.match(helper, /writePhase: 'update-confirm-skip'/);
  assert.match(helper, /decideCodexUpdatePromptDismissal\(/);
  assert.doesNotMatch(helper, /'\\x1b\[B\\r'/);
});

test('update prompt is marked handled only after exact dismissal proof', () => {
  const handler = main.slice(
    main.indexOf('function tryHandleCodexStartupAutoEnter'),
    main.indexOf('function normalizeCodexPickerValue'),
  );
  const updateBranchStart = handler.indexOf("if (promptType === 'update-available')");
  assert.ok(updateBranchStart >= 0, 'update action branch must exist');
  const updateBranch = handler.slice(
    updateBranchStart,
    handler.indexOf("} else if (promptType === 'model-migration')", updateBranchStart),
  );
  assert.match(updateBranch, /performCodexStartupUpdateAutoSkip\(/);
  assert.match(updateBranch, /if \(!outcome\.success\)/);
  assert.match(updateBranch, /CODEX_STARTUP_UPDATE_ACTION_MAX_ATTEMPTS/);
  assert.ok(
    updateBranch.indexOf('if (!outcome.success)')
      < updateBranch.indexOf('state.firedTypes.add(promptType)'),
    'the prompt cannot be marked handled before dismissal succeeds',
  );
  assert.match(handler, /if \(state\.actionInFlightPrompt\) return/);
});
