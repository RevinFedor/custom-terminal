const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');

test('F5: Terminal MCP, Project API, and main lifecycle carry causal execution context end to end', () => {
  const terminalServer = fs.readFileSync(path.join(root, 'mcp/terminal-server.mjs'), 'utf8');
  const webServer = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

  assert.match(terminalServer, /sourceMeta:\s*buildSourceMeta\(\)/);
  assert.match(webServer, /resolveCausalSourceExecutionContext\(\{/);
  assert.match(webServer, /sourceExecutionContext,/);
  assert.match(main, /getAgentExecutionContext:\s*getActiveAgentExecutionContext/);
  assert.match(main, /provider:\s*'claude',[\s\S]{0,160}turnId:\s*taskTurnId/);
  assert.match(main, /provider:\s*'claude',[\s\S]{0,220}processId:\s*ppid/);
  assert.match(main, /provider:\s*'codex',[\s\S]{0,160}turnId:\s*lifecycleTurnId/);
});

test('OR2: exact prompt audit carries target execution context into the run store', () => {
  const webServer = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const codexAuditStart = main.indexOf('function processCodexUserMessagePasteAudit');
  const codexAuditEnd = main.indexOf('function processCodexSourceAuditOnlyText', codexAuditStart);
  const codexAudit = main.slice(codexAuditStart, codexAuditEnd);

  assert.match(main, /selectUniqueClaudePromptSubmitAudit\(\s*auditsAtHook,\s*submitted_prompt/);
  assert.match(main, /activeExecutionContext\s*=\s*getActiveAgentExecutionContext\(tabId\)/);
  assert.match(main, /promptSubmitAudit\.executionContext\s*\|\|=\s*activeExecutionContext/);
  assert.match(main, /ambiguous-identical-pending-audits/);
  assert.match(main, /executionContextDiagnostic\s*\|\|=\s*promptAuditOwner\.reason/);
  assert.match(main, /executionContext:\s*contextVerdict\.context/);
  assert.match(main, /replayDeferredCodexPromptAuditExecutionContext\(tabId\)/);
  assert.match(main, /executionContextSource:\s*'codex-task-started'/);
  assert.match(codexAudit, /state\.busy === true[\s\S]{0,120}getActiveAgentExecutionContext\(state\.tabId\)/);
  assert.match(codexAudit, /executionContext:\s*executionContextVerdict\.context/);
  assert.match(codexAudit, /executionContextDiagnostic:\s*executionContextVerdict\.context/);
  assert.match(codexAudit, /queuedAtSubmit:\s*matchedAudit\.queuedAtSubmit\s*===\s*true/);
  assert.match(webServer, /confirmTargetPromptDelivery\(targetRunId,[\s\S]{0,700}executionContext:\s*detail\.executionContext\s*\|\|\s*null/);
});

test('nested completion audit waits for Codex task_started and passes its exact context to the store', () => {
  const webServer = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const auditRouting = main.slice(
    main.indexOf('function isOrchestrationPromptAudit'),
    main.indexOf('function finishClaudePasteAudit'),
  );
  const completionSend = webServer.slice(
    webServer.indexOf('async function sendOrchestrationCompletionNotification'),
    webServer.indexOf('async function notifyAgentPromptAuditResult'),
  );
  const completionConfirm = webServer.slice(
    webServer.indexOf('const runId = orchestrationCompletionRunIdFromAudit(detail)'),
    webServer.indexOf('async function reconcileOrchestrationSourceFollowup'),
  );

  assert.match(auditRouting, /handoffId\.startsWith\('orchestration:'\)/);
  assert.match(auditRouting, /handoffId\.startsWith\('orchestration-complete:'\)/);
  assert.match(auditRouting, /deferCodexPromptAuditExecutionContext\(detail\)/);
  assert.match(auditRouting, /executionContextSource:\s*'codex-task-started'/);
  assert.match(completionSend, /notifyAgentPromptAuditResult\(\{[\s\S]*?toolType:[\s\S]*?executionContext:\s*audit\.executionContext\s*\|\|\s*null/);
  assert.match(completionSend, /queuedAtSubmit:\s*audit\.queuedAtSubmit\s*===\s*true/);
  assert.match(completionConfirm, /confirmSourceFollowup\(runId,[\s\S]*?toolType:\s*detail\.toolType\s*\|\|\s*null[\s\S]*?executionContext:\s*detail\.executionContext\s*\|\|\s*null/);
  assert.match(completionConfirm, /queuedAtSubmit:\s*detail\.queuedAtSubmit\s*===\s*true/);
  assert.match(webServer, /sameTurnComplete:\s*proof\.complete\s*===\s*true/);
  assert.match(webServer, /persistedParentContext[\s\S]{0,800}sourceFollowupExecutionContext/);
});
