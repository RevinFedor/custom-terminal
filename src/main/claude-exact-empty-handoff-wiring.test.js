'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const history = read('renderer/components/Workspace/HistoryPanel.tsx');
const scenarios = read('renderer/utils/agentScenarios.ts');
const sendAdapter = read('renderer/utils/agentSendAdapter.ts');
const claudeActions = read('renderer/utils/claudePtyActions.ts');
const main = read('main/main.js');
const postEnterStart = main.indexOf('async function inspectClaudePostEnterTimeoutAtWriteBoundary');
const postEnterEnd = main.indexOf('\nfunction waitForClaudePasteAudit', postEnterStart);
const postEnterInspector = main.slice(postEnterStart, postEnterEnd);
const safePasteStart = main.indexOf('async function safePasteAndSubmit(term, content, options = {})');
const safePasteEnd = main.indexOf('\nasync function _safePasteAndSubmitInner', safePasteStart);
const safePasteWrapper = main.slice(safePasteStart, safePasteEnd);

test('History exact-empty proof reaches the final Claude paste boundary', () => {
  assert.match(
    history,
    /claudeExactEmptyEvidence:[\s\S]{0,420}result\?\.proofOutcome === 'absent'/,
    'History must keep the exact empty capture instead of reducing it to a boolean',
  );
  assert.match(
    history,
    /sendAgentPromptScenario\(\{[\s\S]{0,1400}initialComposerProof:\s*claudeExactEmptyEvidence/,
    'History must pass the capture into the shared scenario',
  );
  assert.match(
    sendAdapter,
    /claudeExactEmptyEvidence:\s*input\.composer\?\.exactEmptyEvidence[\s\S]{0,900}runtime\.sendPrompt\(tabId, input\.prompt, options\)/,
    'the provider adapter must keep the proof attached to the same send',
  );
  assert.match(
    claudeActions,
    /ipcRenderer\.invoke\('terminal:paste',[\s\S]{0,700}claudeExactEmptyEvidence: options\.claudeExactEmptyEvidence/,
    'the Claude runtime must carry the proof across IPC',
  );
  assert.match(
    main,
    /withPtyWriteLock\([\s\S]{0,1800}claudeExactEmptyEvidence = reserveClaudeExactEmptyEvidence\(/,
    'main must atomically reserve the proof only after the operation owns the PTY write queue',
  );
  assert.match(
    main,
    /_safePasteAndSubmitInner\(term, content, \{[\s\S]{0,400}claudeExactEmptyEvidence,/,
    'the exact proof reserved at queue activation must stay attached to the same physical paste',
  );
  assert.match(
    main,
    /exactEmptyEvidence: effectiveClaudeExactEmptyEvidence/,
    'the final physical write guard must consume ordinary-send evidence too',
  );
});

test('shared Claude sends keep exact post-Enter audit attached through IPC', () => {
  assert.match(
    claudeActions,
    /const pasteRequest = \{[\s\S]{0,500}awaitClaudeUserMessageAudit: true/,
    'the real Claude runtime must request exact UserPromptSubmit confirmation',
  );
  assert.match(
    main,
    /ipcMain\.handle\('terminal:paste',[\s\S]{0,500}awaitClaudeUserMessageAudit = false/,
    'terminal:paste must accept the exact-audit requirement explicitly',
  );
  assert.match(
    main,
    /safePasteAndSubmit\(term, content, \{[\s\S]{0,600}awaitClaudeUserMessageAudit,/,
    'terminal:paste must carry that requirement to the physical submit owner',
  );
});

test('a real settings mutation forces one fresh exact composer read at the final PTY boundary', () => {
  assert.match(
    claudeActions,
    /requireFreshClaudeExactEmptyBeforePaste: composerMutated/,
    'the renderer must distinguish a settings-mutated composer from an unchanged send',
  );
  assert.match(
    main,
    /if \(requireFreshClaudeExactEmptyBeforePaste\) \{[\s\S]{0,500}captureAgentInputAtWriteBoundary\(/,
    'main must copy the exact composer again while the same paste operation owns the PTY',
  );
  assert.match(
    main,
    /classifyClaudeFreshExactEmptyCapture\(exactCapture\)[\s\S]{0,900}draftPreserved: true/,
    'a restored or foreign stash must be preserved and refuse the task paste',
  );
  assert.match(
    main,
    /sendOperationContext\.claudeExactEmptyEvidence = effectiveClaudeExactEmptyEvidence/,
    'fresh empty evidence must belong to the same active send operation',
  );
});

test('post-Enter timeout gets a non-destructive exact composer and transcript recheck', () => {
  assert.match(
    main,
    /auditResult\?\.error === 'claude_user_message_audit_timeout'[\s\S]{0,500}inspectClaudePostEnterTimeoutAtWriteBoundary/,
    'the shared scenario must inspect a timeout before returning indefinite confirming',
  );
  assert.match(
    postEnterInspector,
    /captureAgentInputAtWriteBoundary\([\s\S]*'copy'[\s\S]*'claude'[\s\S]*readClaudeUserRecords/,
    'the recheck must preserve the composer and read only post-boundary user records',
  );
  assert.doesNotMatch(
    postEnterInspector,
    /term\.write\(/,
    'the post-Enter classifier must not clear, re-submit, or re-paste the composer',
  );
  assert.match(
    main,
    /semanticStatus === 'not-submitted'[\s\S]{0,1800}settleClaudePasteAuditWithoutProjection/,
    'only the exact final semantic failure may stop the local audit',
  );
  assert.match(
    postEnterInspector,
    /claudeTurnBusy\.get\(tabId\) === true[\s\S]{0,300}deferUntilClaudeTurnIdle: true/,
    'an active authoritative turn must keep confirming instead of touching its composer',
  );
  assert.match(
    safePasteWrapper,
    /await waitForClaudeAuditOrTurnIdle\([\s\S]{0,900}withPtyWriteLock\([\s\S]{0,500}inspectClaudePostEnterTimeoutAtWriteBoundary/,
    'the turn-end recheck must release the original paste lock before exact capture',
  );
  assert.match(
    main,
    /claudeTurnBusy\.set\(tabId, busy\);[\s\S]{0,180}wakeClaudePostEnterResolutionWaitersForTurnIdle\(tabId, event\)/,
    'the authoritative Stop edge must wake pending post-Enter classification',
  );
  assert.match(
    main,
    /expectedText: content/,
    'the physical provider text must remain available for an exact comparison',
  );
  assert.match(
    main,
    /error: 'paste_render_timeout',[\s\S]{0,180}pasteWritten,[\s\S]{0,80}enterWritten: false,[\s\S]{0,80}pasteRenderConfirmed: false/,
    'a paste write without its render acknowledgement must stay distinct from an Enter write',
  );
});

test('confirmed current-session model and effort are not re-applied before a task', () => {
  assert.match(
    claudeActions,
    /ipcRenderer\.invoke\('claude:get-confirmed-settings',[\s\S]{0,700}planClaudePtySettings/,
    'the scenario must consult exact active-branch proof before issuing slash commands',
  );
  assert.match(claudeActions, /if \(settingPlan\.applyModel\)/);
  assert.match(claudeActions, /if \(settingPlan\.applyEffort\)/);
});
