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
  const actionStart = handler.indexOf("} else if (promptType === 'resume-goal')");
  assert.ok(actionStart >= 0, 'resume-goal action branch must exist');
  const action = handler.slice(actionStart, handler.indexOf('const remainingPromptTypes', actionStart));
  assert.match(action, /readCodexAuthoritativeScreen\([\s\S]*?'startup-resume-goal-action'/);
  assert.match(action, /decideCodexResumeGoalAutoEnter\(\{/);
  assert.match(action, /sameTerminal:/);
  assert.match(action, /sameRunSeq:/);
  assert.match(action, /sameInputRevision:/);
  assert.match(action, /screenAvailable:/);
  assert.match(action, /if \(!admission\.allowed\)/);
  assert.match(action, /term\.write\('\\r'\)/);
  assert.match(action, /resolveCodexResumeGoalPreference\([\s\S]*?codexLastRunCommandPayload\.get\(tabId\)\?\.resumePausedGoal,[\s\S]*?getAppState\?\.\('codexResumePausedGoal'\)/);
  assert.match(action, /term\.write\('\\x1b\[B'\)/);
  assert.match(action, /decideCodexLeaveGoalPausedAutoEnter\(\{/);
  assert.ok(
    action.indexOf('if (!admission.allowed)') < action.indexOf("term.write('\\r')"),
    'Enter must follow final admission',
  );
  assert.match(handler, /remainingPromptTypes\.includes\('resume-goal'\)[\s\S]*?CODEX_STARTUP_AUTO_ENTER_TTL_MS/);
});
