'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const history = read('renderer/components/Workspace/HistoryPanel.tsx');
const scenarios = read('renderer/utils/agentScenarios.ts');
const claudeActions = read('renderer/utils/claudePtyActions.ts');
const main = read('main/main.js');

test('History exact-empty proof reaches the final Claude paste boundary', () => {
  assert.match(
    history,
    /claudeExactEmptyEvidence:[\s\S]{0,420}result\?\.proofOutcome === 'absent'/,
    'History must keep the exact empty capture instead of reducing it to a boolean',
  );
  assert.match(
    history,
    /sendAgentPromptScenario\(\{[\s\S]{0,1200}claudeExactEmptyEvidence,/,
    'History must pass the capture into the shared scenario',
  );
  assert.match(
    scenarios,
    /runtime\.sendPrompt\(tabId, prompt, \{[\s\S]{0,800}claudeExactEmptyEvidence: exactEmptyEvidenceForSend/,
    'the shared scenario must keep the proof attached to the same send',
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
    /exactEmptyEvidence: claudeExactEmptyEvidence \|\| startupExactEmptyEvidence/,
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
