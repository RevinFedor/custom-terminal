'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');

test('Resume goal is a startup blocker and a default managed-launch prompt', () => {
  const blockers = main.slice(
    main.indexOf('function inspectCodexStartupBlockersText'),
    main.indexOf('function invalidateCodexTuiReadyForStartupBlocker'),
  );
  const arm = main.slice(
    main.indexOf('function armCodexStartupAutoEnter'),
    main.indexOf('function clearCodexPendingModelMigration'),
  );
  assert.match(blockers, /inspectCodexResumeGoalPrompt\(text\)/);
  assert.match(blockers, /resumeGoalPrompt\.interactiveVisible[\s\S]*?blockers\.push\('resume-goal'\)/);
  assert.match(arm, /new Set\(\['update-available', 'model-migration', 'trust-directory', 'resume-goal'\]\)/);
  assert.match(arm, /allowedPromptTypes\.has\('resume-goal'\)[\s\S]*?CODEX_STARTUP_AUTO_ENTER_TTL_MS/);
});

test('a late Resume goal prompt is adopted only from a complete live frame', () => {
  const adoption = main.slice(
    main.indexOf('async function maybeAdoptCodexStartupAutoEnterFromLivePrompt'),
    main.indexOf('function isCodexUpdatePrompt'),
  );
  assert.match(adoption, /frameBlockers\.includes\('resume-goal'\)/);
  assert.match(adoption, /inspectCodexResumeGoalPrompt\(frameText\)/);
  assert.match(adoption, /resumeGoalPrompt\.canAutoEnter/);
  assert.match(adoption, /latestDetectedPrompt\.promptType !== detectedPrompt\.promptType/);
  assert.match(adoption, /findAiDescendantProcessesByTab\(tabId, 'codex'\)/);
});

test('Resume goal Enter is revalidated against the exact current lifecycle and screen', () => {
  const handler = main.slice(
    main.indexOf('function tryHandleCodexStartupAutoEnter'),
    main.indexOf('function normalizeCodexPickerValue'),
  );
  assert.match(handler, /if \(promptType === 'resume-goal'\) return;/, 'legacy path cannot also write Goal keys');
  assert.doesNotMatch(handler, /decideCodexResumeGoalAutoEnter/);
  const action = main.slice(main.indexOf('function getCodexRuntimePolicies('), main.indexOf('function observeCurrentCodexStartupGoalFrame('));
  assert.match(action, /withWriteLock: withPtyWriteLock/);
  assert.match(action, /readCodexAuthoritativeScreen\(tabId, 'runtime-policy'\)/);
  assert.match(action, /ptyWriteOwners\.get\(term\) !== owner/);
  assert.match(action, /codexPolicyFrame\(tabId, expectedFrame\.mirror, expectedFrame\.snapshot\)\.valid/);
  assert.match(action, /getAppState\?\.\('codexResumePausedGoal'\)/);
  assert.ok(
    action.indexOf('if (!guard()') < action.indexOf('term.write(key)'),
    'Enter must follow final admission',
  );
  assert.match(handler, /remainingPromptTypes\.includes\('resume-goal'\)[\s\S]*?CODEX_STARTUP_AUTO_ENTER_TTL_MS/);
});
