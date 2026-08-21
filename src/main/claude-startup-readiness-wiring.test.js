'use strict';

/**
 * Wiring guard for the Resume restoration race.
 *
 * Prod scar 2026-07-29 (tab-2637): the first prompt appeared, startup `/model`
 * was admitted, and one millisecond later Claude restored an internal queued
 * notification. The old one-shot readiness bit could not be revoked, so the
 * setting collided with Claude's own work. These assertions keep readiness a
 * renewable current-frame lease and keep Enter tied to the exact pasted
 * command rather than to "some prompt was seen earlier".
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const runtimeSource = fs.readFileSync(
  path.join(__dirname, 'claude-startup-main-runtime.js'),
  'utf8',
);

test('resume history selects the model but cannot suppress its new-generation command', () => {
  assert.match(
    mainSource,
    /restoredModel = resolveClaudeStartupModelValue\(/,
    'provider display labels must become runnable model ids before the startup step',
  );
  assert.doesNotMatch(mainSource, /resolved\.modelAlreadyConfirmed\s*=/);
  assert.doesNotMatch(runtimeSource, /settings\?\.modelAlreadyConfirmed/);
  assert.match(
    runtimeSource,
    /Session history chooses the model we want to restore,[\s\S]{0,300}new process generation/,
  );
});

test('synchronized redraw start revokes readiness and exact frame end may renew it', () => {
  assert.match(
    mainSource,
    /if \(synchronizedFrameBegin\) \{[\s\S]{0,420}claudePromptStability\.markActivity\(/,
  );
  assert.match(
    mainSource,
    /if \(meta\?\.synchronizedFrameEnd === true\) \{\s*observeClaudeSynchronizedFrameFlushed/,
  );
  assert.match(
    mainSource,
    /function observeClaudeSynchronizedFrameFlushed[\s\S]{0,1800}parseClaudeComposerCurrentFrame\(snapshot\)[\s\S]{0,500}claudePromptStability\.markStable\(/,
  );
});

test('Claude busy lifecycle invalidates the current prompt lease', () => {
  assert.match(
    mainSource,
    /const busy = event === 'UserPromptSubmit';[\s\S]{0,500}claudePromptStability\.markBusy\(/,
  );
});

test('startup waits again when a lease changes before any paste bytes are written', () => {
  const start = mainSource.indexOf('sendCommand: async ({ tabId, generation, command');
  const end = mainSource.indexOf('\n  proveCommand:', start);
  assert.ok(start >= 0 && end > start, 'startup send adapter must remain discoverable');
  const adapter = mainSource.slice(start, end);
  assert.match(
    adapter,
    /while \(claudeLaunchGenerationByTab\.get\(tabId\)\?\.generation === generation\)[\s\S]*claudePromptStability\.wait\(tabId, generation\)/,
  );
  assert.match(
    adapter,
    /result\?\.error === 'claude_prompt_not_stable'[\s\S]*result\?\.pasteWritten !== true[\s\S]*prompt-admission-retry[\s\S]*continue;/,
  );
});

test('startup Enter requires the exact command in a fresh headless frame', () => {
  assert.match(
    mainSource,
    /async function verifyClaudeStartupCommandAtEnterBoundary[\s\S]{0,2400}requestTerminalClaudeDraftState\(/,
  );
  assert.match(
    mainSource,
    /proof\?\.proofOutcome !== 'found'[\s\S]{0,700}normalizeClaudeLocalCommandText\(proof\.text\)[\s\S]{0,120}normalizeClaudeLocalCommandText\(command\)/,
  );
  assert.match(
    mainSource,
    /const startupEnterBoundary = startupPromptLease[\s\S]{0,600}verifyClaudeStartupCommandAtEnterBoundary/,
  );
});

test('startup preserves a real native draft before applying settings', () => {
  assert.match(
    mainSource,
    /async function prepareClaudeStartupComposer[\s\S]{0,5200}currentClaudeFrameHasStashMarker\(tabId\)[\s\S]{0,1200}term\.write\('\\x13'\)/,
    'a real current draft must move through Claude stash before startup paste',
  );
  assert.match(
    mainSource,
    /startup-command-after-stash[\s\S]{0,800}proof\?\.proofOutcome === 'absent'/,
    'stash is not assumed successful until a fresh empty composer is proven',
  );
  assert.match(
    mainSource,
    /verifyClaudeVisibleDraftBeforePaste:\s*true[\s\S]{0,120}inputRevisionAlreadyReserved:\s*true/,
    'the final shared write boundary must re-prove emptiness without invalidating its own reservation',
  );
});

test('startup retry submits its own restored slash command instead of stashing it as user text', () => {
  assert.match(
    mainSource,
    /classifyClaudeStartupRetryComposer\(\{[\s\S]{0,300}retryRecovery[\s\S]{0,700}existingOwnedCommand:\s*true/,
    'the retry must classify the exact restored command before the native stash branch',
  );
  assert.match(
    mainSource,
    /submitExistingInput = recovery\?\.kind === 'submit-existing-input'[\s\S]{0,180}composerAdmission\?\.existingOwnedCommand === true[\s\S]{0,400}inspectClaudeExactSettingInput/,
    'the transaction-owned command must use the exact submit-existing-input path',
  );
});

test('ambiguous residual cells use exact Claude input without becoming fail-open', () => {
  assert.match(
    mainSource,
    /async function exactClaudeStartupComposerRead[\s\S]{0,800}captureAgentInput\(tabId, 'copy', 'claude'/,
  );
  assert.match(
    mainSource,
    /exactClaudeEmptyEvidenceStillCurrent\(tabId, captured\)/,
  );
  assert.match(
    mainSource,
    /proof\?\.exactCaptureRecommended === true[\s\S]{0,800}exactClaudeStartupComposerRead/,
  );
});

test('bytes held before Enter remain delivery-unknown until exact transaction proof', () => {
  assert.match(
    mainSource,
    /result\?\.error === 'claude_prompt_not_stable'[\s\S]{0,120}result\?\.pasteWritten === true[\s\S]{0,500}success: true,[\s\S]{0,100}submitted: false/,
  );
});

test('a same-generation exact-empty proof repastes once without weakening Enter admission', () => {
  assert.match(
    mainSource,
    /startupPromptProof:\s*startupEnterBoundary\.proof \|\| null/,
    'the withheld Enter must return the exact frame identity that rejected it',
  );
  assert.match(
    mainSource,
    /startupGenerationStable:[\s\S]{0,120}claudeLaunchGenerationByTab\.get\(tabId\)\?\.generation === generation/,
    'the Ctrl+G proof must attest the same launch generation',
  );
  assert.match(
    mainSource,
    /const capturedIdentity = \{[\s\S]{0,500}terminalIdentityStable:[\s\S]{0,500}mirrorGeneration:/,
    'the exact editor result must carry run, lifecycle, input, and mirror identity',
  );
});

test('submitted startup settings wait for exact transcript events without a result timeout', () => {
  const start = mainSource.indexOf('async function waitForClaudeStartupSlashProofInMain');
  const end = mainSource.indexOf('\nfunction emitClaudeBusyState', start);
  assert.ok(start >= 0 && end > start, 'startup proof owner must remain discoverable');
  const proofOwner = mainSource.slice(start, end);
  assert.doesNotMatch(proofOwner, /Date\.now\(\)\s*\+\s*6500/);
  assert.doesNotMatch(proofOwner, /sleep\(180\)/);
  assert.match(
    proofOwner,
    /sendResult\?\.submitted === false[\s\S]*inspectClaudeExactSettingInput/,
    'only a proven withheld Enter may use current-composer recovery',
  );
  assert.match(
    proofOwner,
    /return claudeStartupProofSession\.wait\(\{[\s\S]*generation,[\s\S]*command,[\s\S]*afterMs/,
    'a possibly submitted command must wait on its exact durable result',
  );
});

test('startup proof wait follows exact session binding and launch generation', () => {
  assert.match(
    mainSource,
    /function beginClaudeLaunchGeneration[\s\S]{0,1600}claudeStartupProofSession\?\.cancel\([\s\S]{0,180}generation-superseded/,
  );
  assert.match(
    mainSource,
    /function clearClaudeLaunchGeneration[\s\S]{0,1200}claudeStartupProofSession\?\.cancel\(/,
  );
  const notifyStart = mainSource.indexOf('function _notifyClaudeSession(tabId, sessionId)');
  assert.ok(notifyStart >= 0, 'Claude session notification boundary must remain discoverable');
  assert.match(
    mainSource.slice(notifyStart, notifyStart + 700),
    /handleBindingChanged\(tabId,\s*\{\s*sessionId,/,
  );
});
